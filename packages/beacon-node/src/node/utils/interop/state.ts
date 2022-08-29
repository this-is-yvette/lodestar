import {Bytes32, phase0, ssz, TimeSeconds} from "@lodestar/types";
import {IChainForkConfig} from "@lodestar/config";
import {BeaconStateAllForks, initializeBeaconStateFromEth1} from "@lodestar/state-transition";
import {createEmptyEpochContextImmutableData} from "@lodestar/state-transition";
import {DepositTree} from "../../../db/repositories/depositDataRoot.js";

export const INTEROP_BLOCK_HASH = Buffer.alloc(32, "B");
export const INTEROP_TIMESTAMP = Math.pow(2, 40);
// Genesis testing settings (spec v1.0.1)
// Note: These configuration settings do not apply to the mainnet and are utilized only by pure Merge testing.
export const GENESIS_GAS_LIMIT = 30000000;
export const GENESIS_BASE_FEE_PER_GAS = BigInt(1000000000);

export type InteropStateOpts = {
  genesisTime?: number;
  eth1BlockHash?: Bytes32;
  eth1Timestamp?: TimeSeconds;
};

export function getInteropState(
  config: IChainForkConfig,
  {
    genesisTime = Math.floor(Date.now() / 1000),
    eth1BlockHash = INTEROP_BLOCK_HASH,
    eth1Timestamp = INTEROP_TIMESTAMP,
  }: InteropStateOpts,
  deposits: phase0.Deposit[],
  fullDepositDataRootList?: DepositTree
): BeaconStateAllForks {
  const latestPayloadHeader = ssz.bellatrix.ExecutionPayloadHeader.defaultViewDU();
  // TODO: when having different test options, consider modifying these values
  latestPayloadHeader.blockHash = eth1BlockHash;
  latestPayloadHeader.timestamp = eth1Timestamp;
  latestPayloadHeader.prevRandao = eth1BlockHash;
  latestPayloadHeader.gasLimit = GENESIS_GAS_LIMIT;
  latestPayloadHeader.baseFeePerGas = GENESIS_BASE_FEE_PER_GAS;
  const state = initializeBeaconStateFromEth1(
    config,
    createEmptyEpochContextImmutableData(config, {genesisValidatorsRoot: Buffer.alloc(32, 0)}),
    eth1BlockHash,
    eth1Timestamp,
    deposits,
    fullDepositDataRootList,
    latestPayloadHeader
  );
  state.genesisTime = genesisTime;
  return state;
}
