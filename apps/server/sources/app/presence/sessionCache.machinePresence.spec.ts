import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

let machineRevokedAt: Date | null = null;
let machineReplacedByMachineId: string | null = null;
const dbMocks = createDbMocks({ machine: ["findUnique"] } as const);
installDbModuleMock({ db: dbMocks.db });

// Resolve the real cache owner before its validity clock is controlled.
const { activityCache } = await import('./sessionCache');

describe("ActivityCache machine presence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        machineRevokedAt = null;
        machineReplacedByMachineId = null;
        dbMocks.reset();
        dbMocks.db.machine.findUnique.mockImplementation(async () => ({
            id: "m1", accountId: "u1", lastActiveAt: new Date(), active: false,
            revokedAt: machineRevokedAt, replacedByMachineId: machineReplacedByMachineId,
        }));
    });

    afterEach(async () => {
        await activityCache.shutdown();
        vi.useRealTimers();
    });

    it("treats revoked machines as invalid", async () => {
        machineRevokedAt = new Date();
        expect(await activityCache.isMachineValid("m1", "u1")).toBe(false);
    });

    it("treats replaced machines as invalid", async () => {
        machineReplacedByMachineId = "m2";
        expect(await activityCache.isMachineValid("m1", "u1")).toBe(false);
    });

    it("reuses a seeded machine validation without issuing any machine lookup", async () => {
        activityCache.seedMachineValidity({ machineId: "m1", userId: "u1", active: true, lastActiveAt: new Date() });

        expect(await activityCache.isMachineValid("m1", "u1")).toBe(true);
        expect(dbMocks.db.machine.findUnique).not.toHaveBeenCalled();
    });

    it('clears cached validity on shutdown', async () => {
        activityCache.seedMachineValidity({ machineId: 'm1', userId: 'u1', active: true, lastActiveAt: new Date() });
        await activityCache.shutdown();

        expect(await activityCache.isMachineValid('m1', 'u1')).toBe(true);
        expect(dbMocks.db.machine.findUnique).toHaveBeenCalledOnce();
    });
});
