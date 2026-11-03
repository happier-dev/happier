import { describe, expect, it } from "vitest";
import { shouldConsumePresenceFromRedis, shouldPublishPresenceToRedis } from "./presenceMode";

describe("presenceMode", () => {
    it("publishes deadline wakes from API and full replicas with Redis enabled", () => {
        const base = {
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "api" })).toBe(true);
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "all" })).toBe(true);
        expect(shouldPublishPresenceToRedis({ ...base, HAPPIER_SOCKET_ADAPTER: 'memory' })).toBe(false);
        expect(shouldPublishPresenceToRedis({ ...base, SERVER_ROLE: "worker" })).toBe(false);
    });

    it("consumes released observations in worker and full roles with Redis enabled", () => {
        const base = {
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        };
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "worker" })).toBe(true);
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "api" })).toBe(false);
        expect(shouldConsumePresenceFromRedis({ ...base, SERVER_ROLE: "all" })).toBe(true);
    });

});
