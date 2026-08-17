import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import { machinePluginCollectionHostReferenceAdapter } from "./pluginCollectionHostReferenceAdapter";

describe("machinePluginCollectionHostReferenceAdapter", () => {
    it.each([
        { row: { revokedAt: null, replacedByMachineId: null }, expected: "available" },
        { row: { revokedAt: new Date(1), replacedByMachineId: null }, expected: "tombstone" },
        { row: { revokedAt: null, replacedByMachineId: "machine-new" }, expected: "tombstone" },
        { row: null, expected: "unavailable" },
    ] as const)("maps canonical Machine state to $expected", async ({ row, expected }) => {
        const findFirst = vi.fn(async () => row);
        // Persistent storage is the system boundary; keep the fixture to the one queried delegate.
        const tx = { machine: { findFirst } } as unknown as Tx;

        await expect(machinePluginCollectionHostReferenceAdapter.resolveInTx({
            tx,
            accountId: "account-1",
            targetId: "machine-1",
        })).resolves.toEqual({ status: expected });
        expect(findFirst).toHaveBeenCalledWith({
            where: { accountId: "account-1", id: "machine-1" },
            select: { revokedAt: true, replacedByMachineId: true },
        });
    });

    it("does not resolve a Machine row owned by another Account", async () => {
        const findFirst = vi.fn(async (query: Readonly<{
            where: Readonly<{ accountId: string; id: string }>;
        }>) => (
            query.where.accountId === "account-owner" && query.where.id === "machine-1"
                ? { revokedAt: null, replacedByMachineId: null }
                : null
        ));
        const tx = { machine: { findFirst } } as unknown as Tx;

        await expect(machinePluginCollectionHostReferenceAdapter.resolveInTx({
            tx,
            accountId: "account-other",
            targetId: "machine-1",
        })).resolves.toEqual({ status: "unavailable" });
        expect(findFirst).toHaveBeenCalledWith({
            where: { accountId: "account-other", id: "machine-1" },
            select: { revokedAt: true, replacedByMachineId: true },
        });
    });
});
