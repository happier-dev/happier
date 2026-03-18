import { beforeEach, describe, expect, it, vi } from "vitest";

const stop = vi.fn(async () => true);
const getIp = vi.fn(async () => "127.0.0.1");
const getPort = vi.fn(async () => 46379);
const create = vi.fn(async () => ({
    getIp,
    getPort,
    stop,
}));

vi.mock("redis-memory-server", () => ({
    RedisMemoryServer: { create },
}));

describe("resolveRedisAdapterValidationRedisUrl", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns the trimmed REDIS_URL when one is set", async () => {
        const { resolveRedisAdapterValidationRedisUrl } = await import("./resolveRedisAdapterValidationRedisUrl");

        const result = await resolveRedisAdapterValidationRedisUrl({ REDIS_URL: "  redis://localhost:6379  " });

        expect(result.redisUrl).toBe("redis://localhost:6379");
        await result.stop();
        expect(create).not.toHaveBeenCalled();
    });

    it("creates a redis-memory-server instance when REDIS_URL is missing", async () => {
        const { resolveRedisAdapterValidationRedisUrl } = await import("./resolveRedisAdapterValidationRedisUrl");

        const result = await resolveRedisAdapterValidationRedisUrl({});

        expect(create).toHaveBeenCalledTimes(1);
        expect(result.redisUrl).toBe("redis://127.0.0.1:46379");
        await result.stop();
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
