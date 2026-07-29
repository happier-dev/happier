import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMachineUpdate = vi.fn();
const markMachineUpdateSent = vi.fn();
vi.mock("./sessionCache", () => ({
    activityCache: { queueMachineUpdate, markMachineUpdateSent },
}));

const shouldPublishPresenceToRedis = vi.fn();
vi.mock("./presenceMode", () => ({ shouldPublishPresenceToRedis }));

const publishMachineAlive = vi.fn(async () => {});
vi.mock("./presenceRedisQueue", () => ({ publishMachineAlive }));

const reassertSessionLatestTurnStatus = vi.fn(async () => ({
    ok: true,
    didApply: true,
    latestTurnId: "turn-1",
    latestTurnStatus: "completed",
    latestTurnStatusObservedAt: 20,
    lastRuntimeIssue: null,
    participantCursors: [],
    badgeAttentionChanged: false,
}));
vi.mock("@/app/session/sessionWriteService", () => ({ reassertSessionLatestTurnStatus }));

const publishSessionTurnMutationUpdate = vi.fn(async () => {});
vi.mock("@/app/session/turns/publishSessionTurnMutationUpdate", () => ({ publishSessionTurnMutationUpdate }));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("presenceRecorder", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shouldPublishPresenceToRedis.mockReturnValue(true);
    });

    it("does not grant legacy alive direct reachability or thinking authority", async () => {
        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10, thinking: false });
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 11, thinking: true });

    });

    it("reconciles a replayed latest turn status before the throttled presence decision", async () => {
        const { recordSessionAlive } = await import("./presenceRecorder");

        await recordSessionAlive({
            accountId: "u1",
            sessionId: "s1",
            timestamp: 20,
            thinking: false,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 20,
        });

        expect(reassertSessionLatestTurnStatus).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 20,
        });
        expect(publishSessionTurnMutationUpdate).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "s1",
            actorUserId: "u1",
            result: expect.objectContaining({ didApply: true }),
        }));
    });

    it("publishes machine alive only when queue returns true and redis mode enabled", async () => {
        queueMachineUpdate.mockReturnValueOnce(true);

        const { recordMachineAlive } = await import("./presenceRecorder");
        await recordMachineAlive({ accountId: "u1", machineId: "m1", timestamp: 10 });

        expect(publishMachineAlive).toHaveBeenCalledTimes(1);
        expect(publishMachineAlive).toHaveBeenCalledWith({ accountId: "u1", machineId: "m1", timestamp: 10 });
        expect(markMachineUpdateSent).toHaveBeenCalledTimes(1);
        expect(markMachineUpdateSent).toHaveBeenCalledWith("m1", 10);
    });

});
