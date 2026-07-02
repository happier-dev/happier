import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../api/testkit/dbMocks";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const recordPresenceFlushRetry = vi.fn();

vi.mock("@/app/monitoring/metrics/index", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
    recordPresenceFlushRetry,
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
let machineLastActiveAtMs = 0;
const dbMocks = createDbMocks({
    session: ["findUnique", "updateMany"],
    machine: ["findUnique", "updateMany"],
} as const);
const transactionMock = createDbTransactionMock(() => ({
    session: {
        findUnique: dbMocks.db.session.findUnique,
        updateMany: dbMocks.db.session.updateMany,
    },
    machine: {
        findUnique: dbMocks.db.machine.findUnique,
        updateMany: dbMocks.db.machine.updateMany,
    },
}));
installDbModuleMock({
    db: transactionMock.wrapDb(dbMocks.db),
});

describe("ActivityCache session presence", () => {
    let activityCache: any | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        sessionLastActiveAtMs = Date.now();
        sessionActive = false;
        machineLastActiveAtMs = Date.now();
        dbMocks.reset();
        transactionMock.transaction.mockClear();
        dbMocks.db.session.findUnique.mockImplementation(async () => ({
            id: "s1",
            lastActiveAt: new Date(sessionLastActiveAtMs),
            active: sessionActive,
        }));
        dbMocks.db.session.updateMany.mockImplementation(async () => ({ count: 1 }));
        dbMocks.db.machine.findUnique.mockImplementation(async () => ({
            id: "m1",
            accountId: "u1",
            lastActiveAt: new Date(machineLastActiveAtMs),
            active: false,
            revokedAt: null,
        }));
        dbMocks.db.machine.updateMany.mockImplementation(async () => ({ count: 1 }));
    });

    afterEach(async () => {
        await activityCache?.shutdown?.();
        activityCache = null;
        vi.unstubAllEnvs();
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

        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: "s1" }),
                data: expect.objectContaining({ active: true, lastActiveAt: expect.any(Date) }),
            }),
        );

        const queuedAgain = activityCache.queueSessionUpdate("s1", "u1", Date.now());
        expect(queuedAgain).toBe(false);
    });

    it("persists thinking state changes without letting legacy heartbeats override terminal turn projections", async () => {
        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        const timestamp = Date.now();
        await activityCache.isSessionValid("s1", "u1");

        expect(activityCache.queueSessionUpdate("s1", "u1", timestamp, true)).toBe(true);
        await (activityCache as any).flushPendingUpdates();

        expect(dbMocks.db.session.updateMany).toHaveBeenNthCalledWith(1,
            expect.objectContaining({
                where: expect.objectContaining({ id: "s1" }),
                data: expect.objectContaining({
                    active: true,
                    lastActiveAt: new Date(timestamp),
                }),
            }),
        );
        expect(dbMocks.db.session.updateMany).toHaveBeenNthCalledWith(2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "s1",
                    latestTurnStatus: { in: ["completed", "cancelled", "failed"] },
                    thinking: true,
                }),
                data: { thinking: false },
            }),
        );
        expect(dbMocks.db.session.updateMany).toHaveBeenNthCalledWith(3,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "s1",
                    OR: [
                        { latestTurnStatus: null },
                        { latestTurnStatus: { notIn: ["completed", "cancelled", "failed"] } },
                    ],
                }),
                data: expect.objectContaining({
                    thinking: true,
                    thinkingAt: new Date(timestamp),
                }),
            }),
        );

        expect(activityCache.queueSessionUpdate("s1", "u1", timestamp + 1_000, true)).toBe(false);
        expect(activityCache.queueSessionUpdate("s1", "u1", timestamp + 2_000, false)).toBe(true);
        await (activityCache as any).flushPendingUpdates();

        expect(dbMocks.db.session.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: "s1" }),
                data: expect.objectContaining({
                    thinking: false,
                    thinkingAt: new Date(timestamp + 2_000),
                }),
            }),
        );
    });

    it("flushes multiple pending sessions in one transaction batch", async () => {
        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        await activityCache.isSessionValid("s2", "u1");

        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);
        expect(activityCache.queueSessionUpdate("s2", "u1", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
        expect(Array.isArray(transactionMock.transaction.mock.calls[0]?.[0])).toBe(true);
        expect(transactionMock.transaction.mock.calls[0]?.[0]).toHaveLength(2);
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(2);
    });

    it("keeps all pending session updates when the batch fails and retries them on the next flush", async () => {
        const { log } = await import("@/utils/logging/log");

        let sawFailure = false;
        dbMocks.db.session.updateMany.mockImplementation(async (args: any) => {
            if (args?.where?.id === "s1" && !sawFailure) {
                sawFailure = true;
                throw new Error("write_failed");
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

        // First flush builds the full batch, but no cached entry is marked flushed when the transaction rejects.
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(2);
        expect((activityCache as any).sessionCache.get("s1:u1")?.pendingUpdate).not.toBeNull();
        expect((activityCache as any).sessionCache.get("s2:u1")?.pendingUpdate).not.toBeNull();

        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ level: "error" }),
            expect.stringContaining("Error updating sessions"),
        );
        expect(recordPresenceFlushRetry).toHaveBeenCalledWith({
            entityType: "session",
            reason: "db-error",
        });

        // Second flush retries the full batch.
        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(4);
        expect((activityCache as any).sessionCache.get("s1:u1")?.pendingUpdate).toBeNull();
        expect((activityCache as any).sessionCache.get("s2:u1")?.pendingUpdate).toBeNull();
    });

    it("backs off the entire flush when a session batch hits P2024", async () => {
        let callCount = 0;
        dbMocks.db.session.updateMany.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                throw Object.assign(new Error("pool exhausted"), { code: "P2024" });
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));

        await activityCache.isSessionValid("s1", "u1");
        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
        expect(recordPresenceFlushRetry).toHaveBeenCalledWith({
            entityType: "session",
            reason: "db-backoff",
        });

        await (activityCache as any).flushPendingUpdates();
        expect(transactionMock.transaction).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        await (activityCache as any).flushPendingUpdates();
        expect(transactionMock.transaction).toHaveBeenCalledTimes(2);
    });

    it("backs off the entire flush when a session update hits a DB-busy error", async () => {
        let callCount = 0;
        dbMocks.db.session.updateMany.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                throw Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));

        await activityCache.isSessionValid("s1", "u1");
        (activityCache as any).machineCache.set("m1", {
            validUntil: Date.now() + 30_000,
            lastUpdateSent: Date.now(),
            pendingUpdate: null,
            userId: "u1",
            active: true,
        });

        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);
        const machineTimestamp = Date.now() + 60_000;
        expect(activityCache.queueMachineUpdate("m1", machineTimestamp)).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.machine.updateMany).not.toHaveBeenCalled();
        expect((activityCache as any).machineCache.get("m1")?.pendingUpdate).toBe(machineTimestamp);
        expect(recordPresenceFlushRetry).toHaveBeenCalledWith({
            entityType: "session",
            reason: "db-backoff",
        });

        await (activityCache as any).flushPendingUpdates();
        expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.machine.updateMany).not.toHaveBeenCalled();
        expect((activityCache as any).machineCache.get("m1")?.pendingUpdate).toBe(machineTimestamp);

        await vi.advanceTimersByTimeAsync(30_000);

        await (activityCache as any).flushPendingUpdates();
        expect(transactionMock.transaction).toHaveBeenCalledTimes(3);
    });

    it("does not start an overlapping timer-driven flush while a previous flush is still in-flight", async () => {
        let resolveFirstWrite: () => void = () => {
            throw new Error("resolveFirstWrite not initialized");
        };
        const firstWriteBarrier = new Promise<void>((resolve) => {
            resolveFirstWrite = () => resolve();
        });

        let callCount = 0;
        dbMocks.db.session.updateMany.mockImplementation(async () => {
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
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(1);

        const inFlightFlush = (activityCache as any).flushInFlight;
        resolveFirstWrite();
        await inFlightFlush;
    });

    it("backs off on socket timeouts to avoid hammering the DB with repeated presence writes", async () => {
        let callCount = 0;
        dbMocks.db.session.updateMany.mockImplementation(async () => {
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
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(1);

        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);

        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(2);
    });

    it("waits for the final shutdown flush before clearing cached session entries", async () => {
        let resolveFinalWrite: () => void = () => {
            throw new Error("resolveFinalWrite not initialized");
        };
        const finalWriteBarrier = new Promise<void>((resolve) => {
            resolveFinalWrite = () => resolve();
        });

        dbMocks.db.session.updateMany.mockImplementation(async () => {
            await finalWriteBarrier;
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);

        const shutdownPromise = activityCache.shutdown();
        try {
            await Promise.resolve();

            expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
            expect((activityCache as any).sessionCache.size).toBe(1);
        } finally {
            resolveFinalWrite();
            await shutdownPromise;
        }

        expect((activityCache as any).sessionCache.size).toBe(0);
    });

    it("bounds the final shutdown flush wait with the configured timeout", async () => {
        vi.stubEnv("HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS", "25");

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        expect(activityCache.queueSessionUpdate("s1", "u1", Date.now())).toBe(true);

        let resolveBlockedWrite: () => void = () => {};
        dbMocks.db.session.updateMany.mockImplementation(async () => await new Promise((resolve) => {
            resolveBlockedWrite = () => resolve({ count: 1 });
        }));

        const shutdownPromise = activityCache.shutdown();
        try {
            await Promise.resolve();

            expect(transactionMock.transaction).toHaveBeenCalledTimes(1);
            expect((activityCache as any).sessionCache.size).toBe(1);

            await vi.advanceTimersByTimeAsync(24);
            expect((activityCache as any).sessionCache.size).toBe(1);

            await vi.advanceTimersByTimeAsync(1);
            await shutdownPromise;
        } finally {
            resolveBlockedWrite();
            await shutdownPromise;
        }

        expect((activityCache as any).sessionCache.size).toBe(0);
    });

    it("does not drop a newer queued session update that arrives while a flush is awaiting the DB", async () => {
        let resolveFirstWrite: () => void = () => {
            throw new Error("resolveFirstWrite not initialized");
        };
        const firstWriteBarrier = new Promise<void>((resolve) => {
            resolveFirstWrite = () => resolve();
        });

        let callCount = 0;
        dbMocks.db.session.updateMany.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                await firstWriteBarrier;
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isSessionValid("s1", "u1");
        const t1 = Date.now();
        expect(activityCache.queueSessionUpdate("s1", "u1", t1)).toBe(true);

        const flush = (activityCache as any).flushPendingUpdates();
        await Promise.resolve();

        // Queue a newer update while the DB write is in-flight.
        const t2 = t1 + 60_000;
        expect(activityCache.queueSessionUpdate("s1", "u1", t2)).toBe(true);

        resolveFirstWrite();
        await flush;

        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledTimes(2);
        expect(dbMocks.db.session.updateMany.mock.calls[1]?.[0]?.data?.lastActiveAt).toEqual(new Date(t2));
    });

    it("uses the caller-provided clock when cleaning up before session activity checks", async () => {
        ({ activityCache } = await import("./sessionCache"));

        const now = Date.now();
        (activityCache as any).sessionCache.set("s1:u1", {
            validUntil: now + 1_000,
            lastUpdateSent: now,
            pendingUpdate: null,
            userId: "u1",
            sessionId: "s1",
            active: true,
        });

        expect(activityCache.isSessionObservedActive("s1", now + 60_000)).toBe(false);
        expect((activityCache as any).sessionCache.size).toBe(0);
    });

    it("clears queued alive updates when a session is marked inactive", async () => {
        ({ activityCache } = await import("./sessionCache"));

        await activityCache.isSessionValid("s1", "u1");
        const t1 = Date.now();
        expect(activityCache.queueSessionUpdate("s1", "u1", t1)).toBe(true);

        activityCache.markSessionInactive("s1", "u1", t1 + 1_000);

        expect(activityCache.isSessionObservedActive("s1")).toBe(false);

        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
    });

    it("marks every cached participant entry for a session inactive", async () => {
        ({ activityCache } = await import("./sessionCache"));

        await activityCache.isSessionValid("s1", "u1");
        await activityCache.isSessionValid("s1", "u2");

        const t1 = Date.now();
        expect(activityCache.queueSessionUpdate("s1", "u1", t1)).toBe(true);
        expect(activityCache.queueSessionUpdate("s1", "u2", t1)).toBe(true);

        activityCache.markSessionInactive("s1", "u1", t1 + 1_000);

        expect(activityCache.isSessionObservedActive("s1")).toBe(false);
        expect((activityCache as any).sessionCache.size).toBe(0);
        expect(activityCache.queueSessionUpdate("s1", "u2", t1 + 2_000)).toBe(false);

        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
    });
});
