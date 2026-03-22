import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../api/testkit/dbMocks";

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

let machineLastActiveAtMs = 0;
let machineRevokedAt: Date | null = null;
const dbMocks = createDbMocks({
    session: ["update"],
    machine: ["findUnique", "updateMany"],
} as const);
const transactionMock = createDbTransactionMock(() => ({
    session: {
        update: dbMocks.db.session.update,
    },
    machine: {
        findUnique: dbMocks.db.machine.findUnique,
        updateMany: dbMocks.db.machine.updateMany,
    },
}));
installDbModuleMock({
    db: transactionMock.wrapDb(dbMocks.db),
});

describe("ActivityCache machine presence", () => {
    let activityCache: any | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        machineLastActiveAtMs = Date.now();
        machineRevokedAt = null;
        dbMocks.reset();
        transactionMock.transaction.mockClear();
        dbMocks.db.machine.findUnique.mockImplementation(async () => ({
            id: "m1",
            accountId: "u1",
            lastActiveAt: new Date(machineLastActiveAtMs),
            active: false,
            revokedAt: machineRevokedAt,
        }));
        dbMocks.db.machine.updateMany.mockImplementation(async () => ({ count: 1 }));
    });

    afterEach(() => {
        activityCache?.shutdown?.();
        activityCache = null;
        vi.useRealTimers();
    });

    it("forces a DB write to set machine.active=true even when lastActiveAt is already recent", async () => {
        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        const ok = await activityCache.isMachineValid("m1", "u1");
        expect(ok).toBe(true);

        const queued = activityCache.queueMachineUpdate("m1", Date.now());
        expect(queued).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ accountId: "u1", id: "m1", revokedAt: null }),
                data: expect.objectContaining({ active: true, lastActiveAt: expect.any(Date) }),
            }),
        );

        const queuedAgain = activityCache.queueMachineUpdate("m1", Date.now());
        expect(queuedAgain).toBe(false);
    });

    it("treats revoked machines as invalid", async () => {
        machineRevokedAt = new Date("2026-01-01T00:00:00.000Z");

        ({ activityCache } = await import("./sessionCache"));

        const ok = await activityCache.isMachineValid("m1", "u1");
        expect(ok).toBe(false);
    });

    it("does not issue concurrent machine update queries while flushing pending updates", async () => {
        const { log } = await import("@/utils/logging/log");
        let inFlight = 0;
        dbMocks.db.machine.updateMany.mockImplementation(async () => {
            inFlight += 1;
            if (inFlight > 1) {
                throw new Error("concurrent_machine_update");
            }
            await Promise.resolve();
            inFlight -= 1;
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isMachineValid("m1", "u1");
        await activityCache.isMachineValid("m2", "u1");

        expect(activityCache.queueMachineUpdate("m1", Date.now())).toBe(true);
        expect(activityCache.queueMachineUpdate("m2", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ level: "error" }),
            expect.stringContaining("Error updating machines"),
        );
    });

    it("continues flushing other machines and retries failed updates on the next flush", async () => {
        const { log } = await import("@/utils/logging/log");

        let sawFailure = false;
        dbMocks.db.machine.updateMany.mockImplementation(async (args: any) => {
            if (args?.where?.id === "m1" && !sawFailure) {
                sawFailure = true;
                throw new Error("sqlite_busy");
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isMachineValid("m1", "u1");
        await activityCache.isMachineValid("m2", "u1");

        expect(activityCache.queueMachineUpdate("m1", Date.now())).toBe(true);
        expect(activityCache.queueMachineUpdate("m2", Date.now())).toBe(true);

        await (activityCache as any).flushPendingUpdates();

        // First flush attempts both machines (even though the first fails).
        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(2);

        // It should log the error, but not abort the full flush.
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ level: "error" }),
            expect.stringContaining("Error updating machine"),
        );

        // Second flush retries m1 (now succeeds).
        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(3);
    });

    it("does not drop a newer queued machine update that arrives while a flush is awaiting the DB", async () => {
        let resolveFirstWrite: () => void = () => {
            throw new Error("resolveFirstWrite not initialized");
        };
        const firstWriteBarrier = new Promise<void>((resolve) => {
            resolveFirstWrite = () => resolve();
        });

        let callCount = 0;
        dbMocks.db.machine.updateMany.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                await firstWriteBarrier;
            }
            return { count: 1 };
        });

        ({ activityCache } = await import("./sessionCache"));
        activityCache.enableDbFlush();

        await activityCache.isMachineValid("m1", "u1");
        const t1 = Date.now();
        expect(activityCache.queueMachineUpdate("m1", t1)).toBe(true);

        const flush = (activityCache as any).flushPendingUpdates();
        await Promise.resolve();

        // Queue a newer update while the DB write is in-flight.
        const t2 = t1 + 60_000;
        expect(activityCache.queueMachineUpdate("m1", t2)).toBe(true);

        resolveFirstWrite();
        await flush;

        await (activityCache as any).flushPendingUpdates();
        expect(dbMocks.db.machine.updateMany).toHaveBeenCalledTimes(2);
        expect(dbMocks.db.machine.updateMany.mock.calls[1]?.[0]?.data?.lastActiveAt).toEqual(new Date(t2));
    });
});
