import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEnvPatcher } from "@/testkit/env";

const xadd = vi.fn(async () => "0-0");
const getRedisClient = vi.fn(() => ({ xadd }));

vi.mock("@/storage/redis/redis", () => ({ getRedisClient }));
// The cluster broadcast is a separate transport; this spec covers the stream write.
vi.mock("@/app/events/eventRouter", () => ({ eventRouter: { broadcastPresenceDeadline: vi.fn() } }));

describe("presenceRedisQueue", () => {
    const env = createEnvPatcher(["HAPPY_PRESENCE_STREAM_MAXLEN", "HAPPIER_SOCKET_ADAPTER", "REDIS_URL", "SERVER_ROLE"]);

    beforeEach(() => {
        vi.clearAllMocks();
        env.restore();
        env.set("HAPPIER_SOCKET_ADAPTER", "redis-streams");
        env.set("REDIS_URL", "redis://127.0.0.1:6379");
        env.set("SERVER_ROLE", "api");
    });

    afterEach(() => {
        env.restore();
    });

    it("adds MAXLEN trimming by default", async () => {
        const { publishPresenceDeadline } = await import("./presenceRedisQueue");
        await publishPresenceDeadline({ kind: "machine", accountId: "u1", id: "m1", activeAt: 1 });

        expect(getRedisClient).toHaveBeenCalled();
        expect(xadd).toHaveBeenCalledWith(
            "presence:alive:v1",
            "MAXLEN",
            "~",
            "100000",
            "*",
            "kind",
            "machine",
            "id",
            "m1",
            "ts",
            "1",
            "accountId",
            "u1",
        );
    });

    it("uses configured maxlen when provided", async () => {
        env.set("HAPPY_PRESENCE_STREAM_MAXLEN", "123");

        const { publishPresenceDeadline } = await import("./presenceRedisQueue");
        await publishPresenceDeadline({ kind: "machine", accountId: "u1", id: "m1", activeAt: 9 });

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
        env.set("HAPPY_PRESENCE_STREAM_MAXLEN", "0");

        const { publishPresenceDeadline } = await import("./presenceRedisQueue");
        await publishPresenceDeadline({ kind: "machine", accountId: "u1", id: "m1", activeAt: 1 });

        expect(xadd).toHaveBeenCalledWith(
            "presence:alive:v1",
            "*",
            "kind",
            "machine",
            "id",
            "m1",
            "ts",
            "1",
            "accountId",
            "u1",
        );
    });
});
