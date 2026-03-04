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

let machineLastActiveAtMs = 0;
let machineRevokedAt: Date | null = null;
const machineFindUnique = vi.fn(async () => ({
    id: "m1",
    accountId: "u1",
    lastActiveAt: new Date(machineLastActiveAtMs),
    active: false,
    revokedAt: machineRevokedAt,
}));
const machineUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));
const dbTransaction = vi.fn(async (ops: any) => {
    if (typeof ops === "function") {
        return ops({
            session: {
                update: vi.fn(),
            },
            machine: {
                findUnique: machineFindUnique,
                updateMany: machineUpdateMany,
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
            update: vi.fn(),
        },
        machine: {
            findUnique: machineFindUnique,
            updateMany: machineUpdateMany,
        },
    },
}));

describe("ActivityCache machine presence", () => {
    let activityCache: any | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        machineLastActiveAtMs = Date.now();
        machineRevokedAt = null;
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

        expect(machineUpdateMany).toHaveBeenCalledTimes(1);
        expect(machineUpdateMany).toHaveBeenCalledWith(
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
        machineUpdateMany.mockImplementation(async () => {
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
        machineUpdateMany.mockImplementation(async (args: any) => {
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
        expect(machineUpdateMany).toHaveBeenCalledTimes(2);

        // It should log the error, but not abort the full flush.
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ level: "error" }),
            expect.stringContaining("Error updating machine"),
        );

        // Second flush retries m1 (now succeeds).
        await (activityCache as any).flushPendingUpdates();
        expect(machineUpdateMany).toHaveBeenCalledTimes(3);
    });
});
