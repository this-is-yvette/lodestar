import {MapDef} from "@lodestar/utils";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  PeerAction,
  PeerRpcScoreStore,
  RealScore,
  ScoreState,
  updateGossipsubScores,
} from "../../../../src/network/peers/score/index.js";
import {peerIdFromString} from "../../../../src/util/peerId.js";

vi.mock("../../../../src/network/peers/score/index.js", async (importActual) => {
  const mod = await importActual<typeof import("../../../../src/network/peers/score/index.js")>();

  vi.spyOn(mod.PeerRpcScoreStore.prototype, "updateGossipsubScore").mockImplementation(() => {});

  return {
    ...mod,
  };
});

describe("simple block provider score tracking", () => {
  const peer = peerIdFromString("Qma9T5YraSnpRDZqRR4krcSJabThc8nwZuJV3LercPHufi");
  const MIN_SCORE = -100;
  const actionName = "test-action";

  function mockStore() {
    const scoreStore = new PeerRpcScoreStore();
    const peerScores = scoreStore["scores"] as MapDef<string, RealScore>;
    return {scoreStore, peerScores};
  }

  it("Should return default score, without any previous action", () => {
    const {scoreStore} = mockStore();
    const score = scoreStore.getScore(peer);
    expect(score).toBe(0);
  });

  const timesToBan: [PeerAction, number][] = [
    [PeerAction.Fatal, 1],
    [PeerAction.LowToleranceError, 5],
    [PeerAction.MidToleranceError, 10],
    [PeerAction.HighToleranceError, 50],
  ];

  for (const [peerAction, times] of timesToBan)
    it(`Should ban peer after ${times} ${peerAction}`, async () => {
      const {scoreStore} = mockStore();
      for (let i = 0; i < times; i++) scoreStore.applyAction(peer, peerAction, actionName);
      expect(scoreStore.getScoreState(peer)).toBe(ScoreState.Banned);
    });

  const factorForJsBadMath = 1.1;
  const decayTimes: [number, number][] = [
    // [MinScore, timeToDecay]
    [-50, 10 * 60 * 1000],
    [-25, 20 * 60 * 1000],
    [-5, 40 * 60 * 1000],
  ];
  for (const [minScore, timeToDecay] of decayTimes)
    it(`Should decay MIN_SCORE to ${minScore} after ${timeToDecay} ms`, () => {
      const {scoreStore, peerScores} = mockStore();
      const peerScore = peerScores.get(peer.toString());
      if (peerScore) {
        peerScore["lastUpdate"] = Date.now() - timeToDecay * factorForJsBadMath;
        peerScore["lodestarScore"] = MIN_SCORE;
      }
      scoreStore.update();
      expect(scoreStore.getScore(peer)).toBeGreaterThan(minScore);
    });

  it("should not go below min score", () => {
    const {scoreStore} = mockStore();
    scoreStore.applyAction(peer, PeerAction.Fatal, actionName);
    scoreStore.applyAction(peer, PeerAction.Fatal, actionName);
    expect(scoreStore.getScore(peer)).toBeGreaterThanOrEqual(MIN_SCORE);
  });
});

describe("updateGossipsubScores", () => {
  let peerRpcScoresStub: PeerRpcScoreStore;

  beforeEach(() => {
    peerRpcScoresStub = vi.mocked(new PeerRpcScoreStore());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const testCases: {name: string; peerScores: [string, number, boolean][]; maxIgnore: number}[] = [
    {
      name: "Should NOT ignore negative score of <= -1000",
      peerScores: [
        ["a", 10, false],
        // ignore the next 3 because maxIgnore is 5
        ["b", -10, true],
        ["c", -20, true],
        ["d", -5, true],
        // not ignore because score is low
        ["e", -1000, false],
      ],
      maxIgnore: 5,
    },
    {
      name: "Should NOT ignore last negative score",
      peerScores: [
        ["a", 10, false],
        // ignore the next 3 because maxIgnore is 5
        ["b", -10, true],
        ["c", -20, true],
        ["d", -5, true],
        // not ignore because maxIgnore is 3
        ["e", -30, false],
      ],
      maxIgnore: 3,
    },
  ];

  for (const {name, peerScores, maxIgnore} of testCases) {
    it(name, () => {
      const peerScoreMap = new Map<string, number>();
      for (const [key, value] of peerScores) {
        peerScoreMap.set(key, value);
      }
      updateGossipsubScores(peerRpcScoresStub, peerScoreMap, maxIgnore);
      for (const [key, value, ignore] of peerScores) {
        expect(peerRpcScoresStub.updateGossipsubScore).toHaveBeenCalledWith(key, value, ignore);
      }
    });
  }
});
