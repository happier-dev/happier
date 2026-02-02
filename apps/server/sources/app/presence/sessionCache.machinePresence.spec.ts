import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

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
const machineFindUnique = vi.fn(async () => ({
    id: "m1",
    accountId: "u1",
    lastActiveAt: new Date(machineLastActiveAtMs),
    active: false,
}));
const machineUpdate = vi.fn(async () => ({ id: "m1" }));

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            update: vi.fn(),
        },
        machine: {
            findUnique: machineFindUnique,
            update: machineUpdate,
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

        expect(machineUpdate).toHaveBeenCalledTimes(1);
        expect(machineUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.anything(),
                data: expect.objectContaining({ active: true, lastActiveAt: expect.any(Date) }),
            }),
        );

        const queuedAgain = activityCache.queueMachineUpdate("m1", Date.now());
        expect(queuedAgain).toBe(false);
    });
});
