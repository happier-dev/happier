import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../api/testkit/dbMocks";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/monitoring/metrics/index", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

const dbMocks = createDbMocks({
    session: ["findUnique", "updateMany"],
    machine: ["findUnique", "updateMany"],
} as const);
const transactionMock = createDbTransactionMock(() => ({
    session: dbMocks.db.session,
    machine: dbMocks.db.machine,
}));
installDbModuleMock({ db: transactionMock.wrapDb(dbMocks.db) });

// Resolve the real owner before fake timers control its behavioral deadlines.
await import('./sessionCache');

describe("ActivityCache session observations", () => {
    let activityCache: any | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        dbMocks.reset();
        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            accountId: "u1",
            active: false,
            lastActiveAt: new Date(),
        });
    });

    afterEach(async () => {
        await activityCache?.shutdown?.();
        activityCache = null;
        vi.useRealTimers();
    });

    it("uses the caller-provided clock when cleaning up session observations", async () => {
        ({ activityCache } = await import("./sessionCache"));
        const now = Date.now();
        (activityCache as any).sessionCache.set("s1:u1", {
            validUntil: now + 1_000,
            lastUpdateSent: now,
            userId: "u1",
            sessionId: "s1",
            active: true,
        });

        expect(activityCache.isSessionObservedActive("s1", now + 60_000)).toBe(false);
        expect((activityCache as any).sessionCache.size).toBe(0);
    });

    it("clears every cached observation for a session when it becomes inactive", async () => {
        ({ activityCache } = await import("./sessionCache"));
        await activityCache.isSessionValid("s1", "u1");
        activityCache.seedSessionValidity({
            sessionId: "s1",
            userId: "u2",
            active: true,
            lastActiveAt: new Date(),
        });

        activityCache.markSessionInactive("s1", "u1", Date.now());

        expect(activityCache.isSessionObservedActive("s1")).toBe(false);
        expect((activityCache as any).sessionCache.size).toBe(0);
    });
});
