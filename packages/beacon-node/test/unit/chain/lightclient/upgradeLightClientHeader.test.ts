import {createBeaconConfig, createChainForkConfig, defaultChainConfig} from "@lodestar/config";
import {upgradeLightClientHeader} from "@lodestar/light-client/spec";
import {ForkName, ForkSeq} from "@lodestar/params";
import {LightClientHeader, ssz} from "@lodestar/types";
import {beforeEach, describe, expect, it} from "vitest";

describe("UpgradeLightClientHeader", () => {
  let lcHeaderByFork: Record<ForkName, LightClientHeader>;
  let testSlots: Record<ForkName, number>;

  const chainConfig = createChainForkConfig({
    ...defaultChainConfig,
    ALTAIR_FORK_EPOCH: 1,
    BELLATRIX_FORK_EPOCH: 2,
    CAPELLA_FORK_EPOCH: 3,
    DENEB_FORK_EPOCH: 4,
    ELECTRA_FORK_EPOCH: 5,
  });

  const genesisValidatorsRoot = Buffer.alloc(32, 0xaa);
  const config = createBeaconConfig(chainConfig, genesisValidatorsRoot);

  beforeEach(() => {
    lcHeaderByFork = {
      phase0: ssz.altair.LightClientHeader.defaultValue(),
      altair: ssz.altair.LightClientHeader.defaultValue(),
      capella: ssz.capella.LightClientHeader.defaultValue(),
      bellatrix: ssz.altair.LightClientHeader.defaultValue(),
      deneb: ssz.deneb.LightClientHeader.defaultValue(),
      electra: ssz.deneb.LightClientHeader.defaultValue(),
    };

    testSlots = {
      phase0: 0,
      altair: 10,
      bellatrix: 17,
      capella: 25,
      deneb: 33,
      electra: 41,
    };
  });

  for (let i = ForkSeq.altair; i < Object.values(ForkName).length; i++) {
    for (let j = i + 1; j < Object.values(ForkName).length; j++) {
      const fromFork = ForkName[ForkSeq[i] as ForkName];
      const toFork = ForkName[ForkSeq[j] as ForkName];

      it(`Successful upgrade ${fromFork}=>${toFork}`, () => {
        lcHeaderByFork[fromFork].beacon.slot = testSlots[fromFork];
        lcHeaderByFork[toFork].beacon.slot = testSlots[fromFork];

        const updatedHeader = upgradeLightClientHeader(config, toFork, lcHeaderByFork[fromFork]);
        expect(updatedHeader).toEqual(lcHeaderByFork[toFork]);
      });
    }
  }

  for (let i = ForkSeq.altair; i < Object.values(ForkName).length; i++) {
    for (let j = i; j > 0; j--) {
      const fromFork = ForkName[ForkSeq[i] as ForkName];
      const toFork = ForkName[ForkSeq[j] as ForkName];

      it(`Throw upgrade error ${fromFork}=>${toFork}`, () => {
        lcHeaderByFork[fromFork].beacon.slot = testSlots[fromFork];
        lcHeaderByFork[toFork].beacon.slot = testSlots[fromFork];

        expect(() => {
          upgradeLightClientHeader(config, toFork, lcHeaderByFork[fromFork]);
        }).toThrow(`Invalid upgrade request from headerFork=${fromFork} to targetFork=${toFork}`);
      });
    }
  }
});
