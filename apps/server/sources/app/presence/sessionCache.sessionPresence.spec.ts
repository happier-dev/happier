import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityCache } from "./sessionCache";

describe("ActivityCache session observations", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(async () => {
        await activityCache.shutdown();
        vi.useRealTimers();
    });

    it("uses the caller-provided clock when cleaning up session observations", async () => {
        const now = Date.now();
        activityCache.seedSessionValidity({ sessionId: "s1", userId: "u1", active: true });

        // Past the 5 min cleanup interval by the caller's clock (the system clock stays at `now`).
        expect(activityCache.isSessionObservedActive("s1", now + 6 * 60_000)).toBe(false);
        // Cleanup dropped the expired observation instead of only skipping it.
        expect(activityCache.isSessionObservedActive("s1", now)).toBe(false);
    });

    it("clears every cached observation for a session when it becomes inactive", async () => {
        activityCache.seedSessionValidity({ sessionId: "s1", userId: "u1", active: true });
        activityCache.seedSessionValidity({ sessionId: "s1", userId: "u2", active: true });
        expect(activityCache.isSessionObservedActive("s1")).toBe(true);

        activityCache.markSessionInactive("s1", "u1", Date.now());

        expect(activityCache.isSessionObservedActive("s1")).toBe(false);
    });
});
