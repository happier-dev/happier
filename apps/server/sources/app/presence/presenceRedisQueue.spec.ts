import { beforeEach, describe, expect, it, vi } from "vitest";

const xadd = vi.fn(async () => "0-0");
const getRedisClient = vi.fn(() => ({ xadd }));

vi.mock("@/storage/redis", () => ({ getRedisClient }));

describe("presenceRedisQueue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.HAPPY_PRESENCE_STREAM_MAXLEN;
    });

    it("adds MAXLEN trimming by default", async () => {
        const { publishSessionAlive } = await import("./presenceRedisQueue");
        await publishSessionAlive({ sessionId: "s1", timestamp: 1, accountId: "u1" });

        expect(getRedisClient).toHaveBeenCalled();
        expect(xadd).toHaveBeenCalledWith(
            "presence:alive:v1",
            "MAXLEN",
            "~",
            "100000",
            "*",
            "kind",
            "session",
            "id",
            "s1",
            "ts",
            "1",
            "accountId",
            "u1",
        );
    });

    it("uses configured maxlen when provided", async () => {
        process.env.HAPPY_PRESENCE_STREAM_MAXLEN = "123";

        const { publishMachineAlive } = await import("./presenceRedisQueue");
        await publishMachineAlive({ accountId: "u1", machineId: "m1", timestamp: 9 });

        expect(xadd).toHaveBeenCalledWith(
            "presence:alive:v1",
            "MAXLEN",
            "~",
            "123",
            "*",
            "kind",
            "machine",
            "id",
            "m1",
            "ts",
            "9",
            "accountId",
            "u1",
        );
    });

    it("disables trimming when maxlen is 0", async () => {
        process.env.HAPPY_PRESENCE_STREAM_MAXLEN = "0";

        const { publishSessionAlive } = await import("./presenceRedisQueue");
        await publishSessionAlive({ sessionId: "s1", timestamp: 1, accountId: "u1" });

        expect(xadd).toHaveBeenCalledWith(
            "presence:alive:v1",
            "*",
            "kind",
            "session",
            "id",
            "s1",
            "ts",
            "1",
            "accountId",
            "u1",
        );
    });
});

