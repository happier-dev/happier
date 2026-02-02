import { describe, expect, it } from "vitest";
import { shouldConsumePresenceFromRedis, shouldEnableLocalPresenceDbFlush, shouldPublishPresenceToRedis } from "./presenceMode";

describe("presenceMode", () => {
    it("enables local DB flush in lite", () => {
        const env: any = { HAPPY_SERVER_FLAVOR: "light", SERVER_ROLE: "api" };
        expect(shouldEnableLocalPresenceDbFlush(env)).toBe(true);
    });

    it("publishes to redis only in full api role with adapter enabled", () => {
        const base: any = {
            HAPPY_SERVER_FLAVOR: "full",
            HAPPY_SOCKET_REDIS_ADAPTER: "1",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "api" })).toBe(true);
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "all" })).toBe(false);
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "worker" })).toBe(false);
    });

    it("consumes from redis only in full worker role with adapter enabled", () => {
        const base: any = {
            HAPPY_SERVER_FLAVOR: "full",
            HAPPY_SOCKET_REDIS_ADAPTER: "1",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "worker" })).toBe(true);
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "api" })).toBe(false);
    });

    it("disables local DB flush when publishing to redis in api role", () => {
        const env: any = {
            HAPPY_SERVER_FLAVOR: "full",
            SERVER_ROLE: "api",
            HAPPY_SOCKET_REDIS_ADAPTER: "1",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldEnableLocalPresenceDbFlush(env)).toBe(false);
    });
});

