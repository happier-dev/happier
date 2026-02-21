import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: vi.fn(async () => ({
        userId: "u1",
        sessionId: "s1",
        level: "owner",
        isOwner: true,
    })),
}));

let sessionLastActiveAtMs = 0;
let sessionActive = false;
const sessionFindUnique = vi.fn(async () => ({
    id: "s1",
    lastActiveAt: new Date(sessionLastActiveAtMs),
    active: sessionActive,
}));
const sessionUpdateMany = vi.fn(async () => ({ count: 1 }));

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: sessionFindUnique,
            updateMany: sessionUpdateMany,
        },
        machine: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
    },
}));

describe("ActivityCache session presence", () => {
    let activityCache: any | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        sessionLastActiveAtMs = Date.now();
        sessionActive = false;
    });

    afterEach(() => {
        activityCache?.shutdown?.();
        activityCache = null;
        vi.useRealTimers();
    });

    it("forces a DB write to set session.active=true even when lastActiveAt is already recent", async () => {
        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        const ok = await activityCache.isSessionValid("s1", "u1");
        expect(ok).toBe(true);

        const queued = activityCache.queueSessionUpdate("s1", "u1", Date.now());
        expect(queued).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(sessionUpdateMany).toHaveBeenCalledTimes(1);
        expect(sessionUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: "s1" }),
                data: expect.objectContaining({ active: true, lastActiveAt: expect.any(Date) }),
            }),
        );

        const queuedAgain = activityCache.queueSessionUpdate("s1", "u1", Date.now());
        expect(queuedAgain).toBe(false);
    });
});

