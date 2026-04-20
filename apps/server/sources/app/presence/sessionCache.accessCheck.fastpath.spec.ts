import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/monitoring/metrics/index", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
} as const);

installDbModuleMock({ db: dbMocks.db });

describe("ActivityCache session validation fast path", () => {
    let activityCache: typeof import("./sessionCache").activityCache | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        dbMocks.db.session.findUnique.mockResolvedValue({
            id: "s1",
            accountId: "u1",
            active: true,
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
        } as any);
    });

    afterEach(() => {
        activityCache?.shutdown?.();
        activityCache = null;
    });

    it("reuses the access-control session row instead of issuing a second session lookup", async () => {
        ({ activityCache } = await import("./sessionCache"));

        const ok = await activityCache.isSessionValid("s1", "u1");

        expect(ok).toBe(true);
        expect(dbMocks.db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "s1" },
                select: expect.objectContaining({
                    accountId: true,
                    active: true,
                    lastActiveAt: true,
                }),
            }),
        );
    });

    it("reuses a seeded session validation without issuing any session lookup", async () => {
        ({ activityCache } = await import("./sessionCache"));

        activityCache.seedSessionValidity({
            sessionId: "s1",
            userId: "u1",
            active: true,
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
        });

        dbMocks.db.session.findUnique.mockClear();

        const ok = await activityCache.isSessionValid("s1", "u1");

        expect(ok).toBe(true);
        expect(dbMocks.db.session.findUnique).not.toHaveBeenCalled();
    });
});
