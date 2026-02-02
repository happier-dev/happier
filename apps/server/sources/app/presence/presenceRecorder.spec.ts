import { beforeEach, describe, expect, it, vi } from "vitest";

const queueSessionUpdate = vi.fn();
const queueMachineUpdate = vi.fn();
const markSessionUpdateSent = vi.fn();
const markMachineUpdateSent = vi.fn();
vi.mock("./sessionCache", () => ({
    activityCache: { queueSessionUpdate, queueMachineUpdate, markSessionUpdateSent, markMachineUpdateSent },
}));

const shouldPublishPresenceToRedis = vi.fn();
vi.mock("./presenceMode", () => ({ shouldPublishPresenceToRedis }));

const publishSessionAlive = vi.fn(async () => {});
const publishMachineAlive = vi.fn(async () => {});
vi.mock("./presenceRedisQueue", () => ({ publishSessionAlive, publishMachineAlive }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

describe("presenceRecorder", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shouldPublishPresenceToRedis.mockReturnValue(true);
    });

    it("publishes session alive only when queue returns true and redis mode enabled", async () => {
        queueSessionUpdate.mockReturnValueOnce(false).mockReturnValueOnce(true);

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10 });
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 11 });

        expect(publishSessionAlive).toHaveBeenCalledTimes(1);
        expect(publishSessionAlive).toHaveBeenCalledWith({ sessionId: "s1", timestamp: 11, accountId: "u1" });
        expect(markSessionUpdateSent).toHaveBeenCalledTimes(1);
        expect(markSessionUpdateSent).toHaveBeenCalledWith("s1", "u1", 11);
    });

    it("does not publish when redis mode disabled", async () => {
        shouldPublishPresenceToRedis.mockReturnValue(false);
        queueSessionUpdate.mockReturnValueOnce(true);

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10 });

        expect(publishSessionAlive).not.toHaveBeenCalled();
        expect(markSessionUpdateSent).not.toHaveBeenCalled();
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

    it("does not mark as sent when publish fails", async () => {
        queueSessionUpdate.mockReturnValueOnce(true);
        publishSessionAlive.mockRejectedValueOnce(new Error("redis down"));

        const { recordSessionAlive } = await import("./presenceRecorder");
        await recordSessionAlive({ accountId: "u1", sessionId: "s1", timestamp: 10 });

        expect(markSessionUpdateSent).not.toHaveBeenCalled();
    });
});
