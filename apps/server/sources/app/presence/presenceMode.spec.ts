import { describe, expect, it } from "vitest";
import { shouldConsumePresenceFromRedis, shouldEnableLocalPresenceDbFlush, shouldPublishPresenceToRedis } from "./presenceMode";

describe("presenceMode", () => {
    it("enables local DB flush by default (single-process)", () => {
        const env: any = { SERVER_ROLE: "api" };
        expect(shouldEnableLocalPresenceDbFlush(env)).toBe(true);
    });

    it("publishes to redis only in api role with adapter enabled", () => {
        const base: any = {
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "api" })).toBe(true);
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "all" })).toBe(false);
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "worker" })).toBe(false);
    });

    it("consumes from redis only in worker role with adapter enabled", () => {
        const base: any = {
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "worker" })).toBe(true);
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "api" })).toBe(false);
    });

    it("disables local DB flush when publishing to redis in api role", () => {
        const env: any = {
            SERVER_ROLE: "api",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldEnableLocalPresenceDbFlush(env)).toBe(false);
    });
});
