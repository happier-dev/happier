import { beforeEach, describe, expect, it, vi } from "vitest";

const machineFindFirstMock = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: (...args: unknown[]) => machineFindFirstMock(...args),
        },
    },
}));

import { hasExactMachineReadiness } from "./machineSocketReadiness";

describe("hasExactMachineReadiness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not treat recent durable activity as a connected replacement target", async () => {
        machineFindFirstMock.mockResolvedValueOnce({ id: "machine-new", active: true, lastActiveAt: new Date() });

        await expect(hasExactMachineReadiness("account-1", "machine-new", {
            in: () => ({ fetchSockets: async () => [] }),
        })).resolves.toBe(false);
    });

    it("does not trust a connected socket when the machine is replaced in durable state", async () => {
        machineFindFirstMock.mockResolvedValueOnce(null);

        await expect(hasExactMachineReadiness("account-1", "machine-old", {
            in: () => ({ fetchSockets: async () => [{ data: {
                userId: 'account-1', clientType: 'machine-scoped', machineId: 'machine-old',
            } }] }),
        })).resolves.toBe(false);

        expect(machineFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "account-1",
                id: "machine-old",
                revokedAt: null,
                replacedByMachineId: null,
            }),
        }));
    });

    it('accepts an exact available daemon through the adapter even before its heartbeat updates', async () => {
        machineFindFirstMock.mockResolvedValueOnce({ id: 'machine-new', active: false });
        await expect(hasExactMachineReadiness('account-1', 'machine-new', {
            in: room => {
                expect(room).toBe('machine:machine-new:account-1');
                return { fetchSockets: async () => [{ data: {
                    userId: 'account-1', clientType: 'machine-scoped', machineId: 'machine-new',
                } }] };
            },
        })).resolves.toBe(true);
    });
});
