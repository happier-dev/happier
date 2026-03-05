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
const sessionUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));
const dbTransaction = vi.fn(async (ops: any) => {
    if (typeof ops === "function") {
        return ops({
            session: {
                findUnique: sessionFindUnique,
                updateMany: sessionUpdateMany,
            },
            machine: {
                findUnique: vi.fn(),
                updateMany: vi.fn(),
            },
        });
    }
    const out: unknown[] = [];
    for (const op of ops) out.push(await op);
    return out;
});

vi.mock("@/storage/db", () => ({
    db: {
        $transaction: dbTransaction,
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

    it("does not issue concurrent session update queries while flushing pending updates", async () => {
        const { log } = await import("@/utils/logging/log");
        let inFlight = 0;
        sessionUpdateMany.mockImplementation(async () => {
            inFlight += 1;
            if (inFlight > 1) {
                throw new Error("concurrent_session_update");
            }
            await Promise.resolve();
            inFlight -= 1;
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        await activityCache.isSessionValid("s2", "u1");

        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);
        expect(activityCache.queueSessionUpdate("s2", "u1", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ level: "error" }),
            expect.stringContaining("Error updating sessions"),
        );
    });

    it("continues flushing other sessions and retries failed updates on the next flush", async () => {
        const { log } = await import("@/utils/logging/log");

        let sawFailure = false;
        sessionUpdateMany.mockImplementation(async (args: any) => {
            if (args?.where?.id === "s1" && !sawFailure) {
                sawFailure = true;
                throw new Error("sqlite_busy");
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        await activityCache.isSessionValid("s2", "u1");

        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);
        expect(activityCache.queueSessionUpdate("s2", "u1", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        // First flush attempts both sessions (even though the first fails).
        expect(sessionUpdateMany).toHaveBeenCalledTimes(2);

        // It should log the error, but not abort the full flush.
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ level: "error" }),
            expect.stringContaining("Error updating session"),
        );

        // Second flush retries s1 (now succeeds).
        await (activityCache as any).flushPendingUpdates();
        expect(sessionUpdateMany).toHaveBeenCalledTimes(3);
    });

	    it("does not start an overlapping timer-driven flush while a previous flush is still in-flight", async () => {
	        let resolveFirstWrite: () => void = () => {
	            throw new Error("resolveFirstWrite not initialized");
	        };
	        const firstWriteBarrier = new Promise<void>(resolve => {
	            resolveFirstWrite = () => resolve();
	        });

	        let callCount = 0;
	        sessionUpdateMany.mockImplementation(async () => {
	            callCount += 1;
            if (callCount === 1) {
                await firstWriteBarrier;
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);

        // Tick the flush interval twice without letting the first write resolve.
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);

	        // The second timer tick should not start a new flush (no overlapping DB queries).
	        expect(sessionUpdateMany).toHaveBeenCalledTimes(1);

	        resolveFirstWrite();
	        await Promise.resolve();
	    });

    it("backs off on socket timeouts to avoid hammering the DB with repeated presence writes", async () => {
        let callCount = 0;
        sessionUpdateMany.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                throw new Error("Socket timeout (the database failed to respond to a query within the configured timeout)");
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));

        await activityCache.isSessionValid("s1", "u1");
        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();
        expect(sessionUpdateMany).toHaveBeenCalledTimes(1);

        await (activityCache as any).flushPendingUpdates();
        expect(sessionUpdateMany).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);

        await (activityCache as any).flushPendingUpdates();
        expect(sessionUpdateMany).toHaveBeenCalledTimes(2);
    });
});
