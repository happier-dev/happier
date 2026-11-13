import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/monitoring/metrics/index", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionGrant: ["findUnique"],
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
            currentStorageState: "hosted",
            grants: [{ principalKind: 'account', accountId: null, teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: "share-1", accessLevel: "admin", canApprovePermissions: true  }],
            active: true,
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
        } as any);
    });

    afterEach(() => {
        activityCache?.shutdown?.();
        activityCache = null;
    });

    it("reads owner activity in one session lookup", async () => {
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

    it("does not admit a shared admin as an owner publisher", async () => {
        ({ activityCache } = await import("./sessionCache"));
        dbMocks.db.sessionGrant.findUnique.mockResolvedValue({
            accessLevel: "admin",
            canApprovePermissions: true,
        });

        await expect(activityCache.isSessionValid("s1", "collaborator")).resolves.toBe(false);
        expect(activityCache.isSessionObservedActive("s1")).toBe(false);
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
