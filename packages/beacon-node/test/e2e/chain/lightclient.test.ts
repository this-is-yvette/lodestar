import {CompactMultiProof, computeDescriptor} from "@chainsafe/persistent-merkle-tree";
import {JsonPath, fromHexString, toHexString} from "@chainsafe/ssz";
import {ApiClient, getClient, routes} from "@lodestar/api";
import {ChainConfig} from "@lodestar/config";
import {Lightclient} from "@lodestar/light-client";
import {LightClientRestTransport} from "@lodestar/light-client/transport";
import {TimestampFormatCode} from "@lodestar/logger";
import {EPOCHS_PER_SYNC_COMMITTEE_PERIOD, SLOTS_PER_EPOCH} from "@lodestar/params";
import {computeStartSlotAtEpoch} from "@lodestar/state-transition";
import {altair, ssz} from "@lodestar/types";
import {afterEach, describe, expect, it, vi} from "vitest";
import {HeadEventData} from "../../../src/chain/index.js";
import {LogLevel, TestLoggerOpts, testLogger} from "../../utils/logger.js";
import {getDevBeaconNode} from "../../utils/node/beacon.js";
import {getAndInitDevValidators} from "../../utils/node/validator.js";

describe("chain / lightclient", () => {
  vi.setConfig({testTimeout: 600_000});

  /**
   * Max distance between beacon node head and lightclient head
   * If SECONDS_PER_SLOT === 1, there should be some margin for slow blocks,
   * 4 = 4 sec should be good enough.
   */
  const maxLcHeadTrackingDiffSlots = 4;
  const validatorCount = 8;
  const validatorClientCount = 4;
  // Reduced from 3 to 1, so test can complete in 10 epoch vs 27 epoch
  const targetSyncCommittee = 1;
  /** N sync committee periods + 1 epoch of margin */
  const finalizedEpochToReach = targetSyncCommittee * EPOCHS_PER_SYNC_COMMITTEE_PERIOD + 1;
  /** Given 100% participation the fastest epoch to reach finalization is +2 epochs. -1 for margin */
  const targetSlotToReach = computeStartSlotAtEpoch(finalizedEpochToReach + 2) - 1;
  const restPort = 9000;

  const testParams: Pick<ChainConfig, "SECONDS_PER_SLOT" | "ALTAIR_FORK_EPOCH"> = {
    SECONDS_PER_SLOT: 1,
    ALTAIR_FORK_EPOCH: 0,
  };

  const afterEachCallbacks: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (afterEachCallbacks.length > 0) {
      const callback = afterEachCallbacks.pop();
      if (callback) await callback();
    }
  });

  it("Lightclient track head on server configuration", async () => {
    // delay a bit so regular sync sees it's up to date and sync is completed from the beginning
    // also delay to allow bls workers to be transpiled/initialized
    const genesisSlotsDelay = 7;
    const genesisTime = Math.floor(Date.now() / 1000) + genesisSlotsDelay * testParams.SECONDS_PER_SLOT;

    const testLoggerOpts: TestLoggerOpts = {
      level: LogLevel.info,
      timestampFormat: {
        format: TimestampFormatCode.EpochSlot,
        genesisTime,
        slotsPerEpoch: SLOTS_PER_EPOCH,
        secondsPerSlot: testParams.SECONDS_PER_SLOT,
      },
    };

    const loggerNodeA = testLogger("lightclientNode", testLoggerOpts);
    const loggerLC = testLogger("LC", {...testLoggerOpts, level: LogLevel.debug});

    const bn = await getDevBeaconNode({
      params: testParams,
      options: {
        sync: {isSingleNode: true},
        network: {allowPublishToZeroPeers: true},
        api: {rest: {enabled: true, api: ["lightclient", "proof"], port: restPort, address: "localhost"}},
        chain: {blsVerifyAllMainThread: true},
      },
      validatorCount: validatorCount * validatorClientCount,
      genesisTime,
      logger: loggerNodeA,
    });

    afterEachCallbacks.push(async () => {
      await bn.close();
    });

    const {validators} = await getAndInitDevValidators({
      node: bn,
      logPrefix: "lightclientNode",
      validatorsPerClient: validatorCount,
      validatorClientCount,
      startIndex: 0,
      useRestApi: false,
      testLoggerOpts: {...testLoggerOpts, level: LogLevel.error},
    });

    afterEachCallbacks.push(async () => {
      await Promise.all(validators.map((v) => v.close()));
    });

    // This promise chain does:
    // 1. Wait for the beacon node to emit one head that has a snapshot associated to it
    // 2. Initialize lightclient from that head block root
    // 3. Start lightclient to track head
    // 4. On every new beacon node head, check that the lightclient is following closely
    //   - If too far behind error the test
    //   - If beacon node reaches the finality slot, resolve test
    const promiseUntilHead = new Promise<HeadEventData>((resolve) => {
      bn.chain.emitter.on(routes.events.EventType.head, async (head) => {
        // Wait for the second slot so syncCommitteeWitness is available
        if (head.slot > 2) {
          resolve(head);
        }
      });
    }).then(async (head) => {
      // Initialize lightclient
      loggerLC.info("Initializing lightclient", {slot: head.slot});
      const api = getClient({baseUrl: `http://localhost:${restPort}`}, {config: bn.config});
      const lightclient = await Lightclient.initializeFromCheckpointRoot({
        config: bn.config,
        logger: loggerLC,
        transport: new LightClientRestTransport(api),
        genesisData: {
          genesisTime: bn.chain.genesisTime,
          genesisValidatorsRoot: bn.chain.genesisValidatorsRoot,
        },
        checkpointRoot: fromHexString(head.block),
      });

      afterEachCallbacks.push(async () => {
        lightclient.stop();
      });

      loggerLC.info("Initialized lightclient", {headSlot: lightclient.getHead().beacon.slot});
      void lightclient.start();

      return new Promise<void>((resolve, reject) => {
        bn.chain.emitter.on(routes.events.EventType.head, async (head) => {
          try {
            // Test fetching proofs
            const {proof, header} = await getHeadStateProof(lightclient, api, [["latestBlockHeader", "bodyRoot"]]);
            const stateRootHex = toHexString(header.beacon.stateRoot);
            const lcHeadState = bn.chain.regen.getStateSync(stateRootHex);
            if (!lcHeadState) {
              throw Error(`LC head state not in cache ${stateRootHex}`);
            }

            const stateLcFromProof = ssz.altair.BeaconState.createFromProof(proof, header.beacon.stateRoot);
            expect(toHexString(stateLcFromProof.latestBlockHeader.bodyRoot)).toBe(
              toHexString(lcHeadState.latestBlockHeader.bodyRoot)
            );

            // Stop test if reached target head slot
            const lcHeadSlot = lightclient.getHead().beacon.slot;
            if (head.slot - lcHeadSlot > maxLcHeadTrackingDiffSlots) {
              throw Error(`Lightclient head ${lcHeadSlot} is too far behind the beacon node ${head.slot}`);
            }

            if (head.slot > targetSlotToReach) {
              resolve();
            }
          } catch (e) {
            reject(e);
          }
        });
      });
    });

    const promiseTillFinalization = new Promise<void>((resolve) => {
      bn.chain.emitter.on(routes.events.EventType.finalizedCheckpoint, (checkpoint) => {
        loggerNodeA.info("Node A emitted finalized checkpoint event", {epoch: checkpoint.epoch});
        if (checkpoint.epoch >= finalizedEpochToReach) {
          resolve();
        }
      });
    });

    await Promise.all([promiseUntilHead, promiseTillFinalization]);

    const headSummary = bn.chain.forkChoice.getHead();
    const head = await bn.db.block.get(fromHexString(headSummary.blockRoot));
    if (!head) throw Error("First beacon node has no head block");
  });
});

// TODO: Re-incorporate for REST-only light-client
async function getHeadStateProof(
  lightclient: Lightclient,
  api: ApiClient,
  paths: JsonPath[]
): Promise<{proof: CompactMultiProof; header: altair.LightClientHeader}> {
  const header = lightclient.getHead();
  const stateId = toHexString(header.beacon.stateRoot);
  const gindices = paths.map((path) => ssz.bellatrix.BeaconState.getPathInfo(path).gindex);
  const descriptor = computeDescriptor(gindices);
  const proof = (await api.proof.getStateProof({stateId, descriptor})).value();
  return {proof, header};
}
