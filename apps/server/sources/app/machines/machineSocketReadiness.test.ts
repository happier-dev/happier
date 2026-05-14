import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectionsMock = vi.fn();
const machineFindFirstMock = vi.fn();

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        getConnections: (...args: unknown[]) => getConnectionsMock(...args),
    },
}));

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

    it("does not trust a local exact socket when the machine is replaced in durable state", async () => {
        getConnectionsMock.mockReturnValue(new Set([
            {
                connectionType: "machine-scoped",
                machineId: "machine-old",
                socket: { connected: true },
            },
        ]));
        machineFindFirstMock.mockResolvedValueOnce(null);

        await expect(hasExactMachineReadiness("account-1", "machine-old")).resolves.toBe(false);

        expect(machineFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "account-1",
                id: "machine-old",
                revokedAt: null,
                replacedByMachineId: null,
            }),
        }));
    });
});
