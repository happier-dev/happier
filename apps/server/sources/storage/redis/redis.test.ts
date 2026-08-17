import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisInstances: Array<EventEmitter & {
    disconnect: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
}> = [];
const redisConstructor = vi.fn(function RedisMock(_url?: string, _options?: unknown) {
    const instance = Object.assign(new EventEmitter(), {
        disconnect: vi.fn(),
        ping: vi.fn(),
    });
    redisInstances.push(instance);
    return instance;
});
const warn = vi.fn();

vi.mock("ioredis", () => ({
    Redis: redisConstructor,
}));

vi.mock("@/app/monitoring/metrics/instrumentRedisClient", () => ({
    instrumentRedisClient: <T>(client: T) => client,
}));

vi.mock("@/utils/logging/log", () => ({
    warn,
}));

describe("getRedisClient", () => {
    beforeEach(() => {
        vi.resetModules();
        redisConstructor.mockClear();
        redisInstances.length = 0;
        warn.mockClear();
        process.env.REDIS_URL = "redis://user:secret@redis.example:6379";
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.REDIS_URL;
    });

    it("keeps ordinary shared-client blocking command semantics", async () => {
        const { getRedisClient } = await import("./redis.js");

        getRedisClient();

        expect(redisConstructor).toHaveBeenCalledWith("redis://user:secret@redis.example:6379");
        expect(redisInstances[0]?.listenerCount("error")).toBe(0);
    });

    it("bounds silent stalls only on the Socket.IO cluster client", async () => {
        const { getRedisSocketClusterClient } = await import("./redis.js");

        getRedisSocketClusterClient();

        expect(redisConstructor).toHaveBeenCalledWith(
            "redis://user:secret@redis.example:6379",
            expect.objectContaining({
                retryStrategy: expect.any(Function),
                socketTimeout: 5_000,
            }),
        );
        const options = redisConstructor.mock.calls[0]?.[1] as {
            retryStrategy: (attempt: number) => number;
        };
        expect(options.retryStrategy(1)).toBe(50);
        expect(options.retryStrategy(2)).toBe(100);
        expect(options.retryStrategy(100)).toBe(2_000);
        redisInstances[0]?.emit("connect");
        redisInstances[0]?.emit(
            "error",
            Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
        );
        expect(options.retryStrategy(2)).toBe(5_050);
        redisInstances[0]?.emit("connect");
        redisInstances[0]?.emit(
            "error",
            new Error("Socket timeout. Expecting data, but didn't receive any in 5000ms."),
        );
        expect(options.retryStrategy(1)).toBe(50);
    });

    it("bounds and sanitizes repeated Socket.IO cluster client error diagnostics", async () => {
        const { getRedisSocketClusterClient } = await import("./redis.js");
        const redis = getRedisSocketClusterClient();
        const rawError = Object.assign(
            new Error("getaddrinfo ENOTFOUND redis.example redis://user:secret@redis.example:6379"),
            { code: "ENOTFOUND" },
        );
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

        expect(() => {
            for (let index = 0; index < 100; index += 1) redis.emit("error", rawError);
        }).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            {
                module: "redis-socket-cluster",
                event: "client_error",
                errorClass: "dns",
                suppressedSinceLastDiagnostic: 0,
            },
            "Socket.IO cluster Redis client error",
        );
        now.mockReturnValue(61_000);
        redis.emit("error", rawError);
        expect(warn).toHaveBeenLastCalledWith(
            {
                module: "redis-socket-cluster",
                event: "client_error",
                errorClass: "dns",
                suppressedSinceLastDiagnostic: 99,
            },
            "Socket.IO cluster Redis client error",
        );
        expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("redis.example");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("getaddrinfo");
    });

    it("disconnects and resets only the dedicated Socket.IO cluster client", async () => {
        const {
            closeRedisSocketClusterClient,
            getRedisClient,
            getRedisSocketClusterClient,
        } = await import("./redis.js");
        const shared = getRedisClient();
        const cluster = getRedisSocketClusterClient();

        closeRedisSocketClusterClient();

        expect(cluster.disconnect).toHaveBeenCalledWith(false);
        expect(shared.disconnect).not.toHaveBeenCalled();
        expect(getRedisSocketClusterClient()).not.toBe(cluster);
    });
});
