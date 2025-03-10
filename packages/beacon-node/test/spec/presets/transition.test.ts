import path from "node:path";
import {ChainConfig, createChainForkConfig} from "@lodestar/config";
import {config} from "@lodestar/config/default";
import {ACTIVE_PRESET, ForkName} from "@lodestar/params";
import {
  BeaconStateAllForks,
  DataAvailableStatus,
  ExecutionPayloadStatus,
  stateTransition,
} from "@lodestar/state-transition";
import {SignedBeaconBlock, ssz} from "@lodestar/types";
import {bnToNum} from "@lodestar/utils";
import {createCachedBeaconStateTest} from "../../utils/cachedBeaconState.js";
import {assertCorrectProgressiveBalances} from "../config.js";
import {ethereumConsensusSpecsTests} from "../specTestVersioning.js";
import {expectEqualBeaconState, inputTypeSszTreeViewDU} from "../utils/expectEqualBeaconState.js";
import {specTestIterator} from "../utils/specTestIterator.js";
import {RunnerType, TestRunnerFn} from "../utils/types.js";
import {getPreviousFork} from "./fork.test.js";

const transition =
  (skipTestNames?: string[]): TestRunnerFn<TransitionTestCase, BeaconStateAllForks> =>
  (forkNext) => {
    if (forkNext === ForkName.phase0) {
      throw Error("fork phase0 not supported");
    }

    const forkPrev = getPreviousFork(config, forkNext);

    /**
     * https://github.com/ethereum/eth2.0-specs/tree/v1.1.0-alpha.5/tests/formats/transition
     */
    function generateBlocksSZZTypeMapping(meta: TransitionTestCase["meta"]): BlocksSZZTypeMapping {
      if (meta === undefined) {
        throw new Error("No meta data found");
      }
      const blocksMapping: BlocksSZZTypeMapping = {};
      // The fork_block is the index in the test data of the last block of the initial fork.
      for (let i = 0; i < meta.blocks_count; i++) {
        blocksMapping[`blocks_${i}`] =
          i <= meta.fork_block ? ssz[forkPrev].SignedBeaconBlock : ssz[forkNext].SignedBeaconBlock;
      }
      return blocksMapping;
    }

    return {
      testFunction: (testcase) => {
        const meta = testcase.meta;

        // testConfig is used here to load forkEpoch from meta.yaml
        const forkEpoch = bnToNum(meta.fork_epoch);
        const testConfig = createChainForkConfig(getTransitionConfig(forkNext, forkEpoch));

        let state = createCachedBeaconStateTest(testcase.pre, testConfig);
        for (let i = 0; i < meta.blocks_count; i++) {
          const signedBlock = testcase[`blocks_${i}`] as SignedBeaconBlock;
          state = stateTransition(state, signedBlock, {
            // Assume valid and available for this test
            executionPayloadStatus: ExecutionPayloadStatus.valid,
            dataAvailableStatus: DataAvailableStatus.available,
            verifyStateRoot: true,
            verifyProposer: false,
            verifySignatures: false,
            assertCorrectProgressiveBalances,
          });
        }
        return state;
      },
      options: {
        inputTypes: inputTypeSszTreeViewDU,
        getSszTypes: (meta: TransitionTestCase["meta"]) => {
          return {
            pre: ssz[forkPrev].BeaconState,
            post: ssz[forkNext].BeaconState,
            ...generateBlocksSZZTypeMapping(meta),
          };
        },
        shouldError: (testCase) => testCase.post === undefined,
        timeout: 10000,
        getExpected: (testCase) => testCase.post,
        expectFunc: (_testCase, expected, actual) => {
          expectEqualBeaconState(forkNext, expected, actual);
        },
        // Do not manually skip tests here, do it in packages/beacon-node/test/spec/presets/index.test.ts
        shouldSkip: (_testcase, name, _index) =>
          skipTestNames?.some((skipTestName) => name.includes(skipTestName)) ?? false,
      },
    };
  };

function getTransitionConfig(fork: ForkName, forkEpoch: number): Partial<ChainConfig> {
  switch (fork) {
    case ForkName.phase0:
      throw Error("phase0 not allowed");
    case ForkName.altair:
      return {ALTAIR_FORK_EPOCH: forkEpoch};
    case ForkName.bellatrix:
      return {ALTAIR_FORK_EPOCH: 0, BELLATRIX_FORK_EPOCH: forkEpoch};
    case ForkName.capella:
      return {ALTAIR_FORK_EPOCH: 0, BELLATRIX_FORK_EPOCH: 0, CAPELLA_FORK_EPOCH: forkEpoch};
    case ForkName.deneb:
      return {ALTAIR_FORK_EPOCH: 0, BELLATRIX_FORK_EPOCH: 0, CAPELLA_FORK_EPOCH: 0, DENEB_FORK_EPOCH: forkEpoch};
    case ForkName.electra:
      return {
        ALTAIR_FORK_EPOCH: 0,
        BELLATRIX_FORK_EPOCH: 0,
        CAPELLA_FORK_EPOCH: 0,
        DENEB_FORK_EPOCH: 0,
        ELECTRA_FORK_EPOCH: forkEpoch,
      };
  }
}

type BlocksSZZTypeMapping = Record<string, (typeof ssz)[ForkName]["SignedBeaconBlock"]>;

type TransitionTestCase = {
  [k: string]: SignedBeaconBlock | unknown | null | undefined;
  meta: {
    post_fork: ForkName;
    fork_epoch: bigint;
    fork_block: bigint;
    blocks_count: bigint;
    bls_setting?: bigint;
  };
  pre: BeaconStateAllForks;
  post: BeaconStateAllForks;
};

specTestIterator(path.join(ethereumConsensusSpecsTests.outputDir, "tests", ACTIVE_PRESET), {
  transition: {
    type: RunnerType.default,
    fn: transition(),
  },
});
