import { describe, expect, it, vi } from "vitest";

import {
    matchMachineAccountEncryptionMigrationPostStateInTx,
    migrateMachineAccountEncryptionInTx,
} from "./migrateMachineAccountEncryptionInTx";

describe("migrateMachineAccountEncryptionInTx", () => {
    it("rejects an incomplete inventory before writing", async () => {
        const updateMany = vi.fn();
        const result = await migrateMachineAccountEncryptionInTx({
            tx: {
                machine: {
                    findMany: vi.fn(async () => [{
                        id: "machine-1",
                        metadataVersion: 2,
                        daemonStateVersion: 3,
                    }]),
                    updateMany,
                },
            } as any,
            accountId: "account-1",
            toMode: "plain",
            directive: { action: "migrate", items: [] },
        });

        expect(result).toEqual({ status: "migration_incomplete" });
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("writes an exact plain replacement through Machine versions", async () => {
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const markChanged = vi.fn(async () => 1);
        const result = await migrateMachineAccountEncryptionInTx({
            tx: {
                machine: {
                    findMany: vi.fn(async () => [{
                        id: "machine-1",
                        metadataVersion: 2,
                        daemonStateVersion: 3,
                    }]),
                    updateMany,
                },
            } as any,
            accountId: "account-1",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    machineId: "machine-1",
                    expectedMetadataVersion: 2,
                    expectedDaemonStateVersion: 3,
                    metadata: "eyJ0IjoicGxhaW4iLCJ2Ijp7Imhvc3QiOiJxYSJ9fQ==",
                    daemonState: null,
                    dataEncryptionKey: "eyJ0IjoicGxhaW4iLCJ2IjpudWxsfQ==",
                    contentPublicKeyFingerprint: null,
                }],
            },
            markChanged,
        });

        expect(result).toEqual({ status: "applied" });
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                id: "machine-1",
                metadataVersion: 2,
                daemonStateVersion: 3,
            },
            data: {
                metadata: "eyJ0IjoicGxhaW4iLCJ2Ijp7Imhvc3QiOiJxYSJ9fQ==",
                metadataVersion: 3,
                daemonState: null,
                daemonStateVersion: 4,
                dataEncryptionKey: expect.any(Uint8Array),
                contentPublicKeyFingerprint: null,
                updatedAt: expect.any(Date),
            },
        });
        expect(markChanged).toHaveBeenCalledWith("machine-1");
    });

    it("matches the exact complete post-state and assert-empty read-only", async () => {
        const item = {
            machineId: "machine-1",
            expectedMetadataVersion: 2,
            expectedDaemonStateVersion: 3,
            metadata: "eyJ0IjoicGxhaW4iLCJ2Ijp7Imhvc3QiOiJxYSJ9fQ==",
            daemonState: null,
            dataEncryptionKey: "eyJ0IjoicGxhaW4iLCJ2IjpudWxsfQ==",
            contentPublicKeyFingerprint: null,
        } as const;
        const findMany = vi.fn(async () => [{
            id: item.machineId,
            metadataVersion: item.expectedMetadataVersion + 1,
            daemonStateVersion: item.expectedDaemonStateVersion + 1,
            metadata: item.metadata,
            daemonState: item.daemonState,
            dataEncryptionKey: new Uint8Array(
                Buffer.from(item.dataEncryptionKey, "base64"),
            ),
            contentPublicKeyFingerprint:
                item.contentPublicKeyFingerprint,
        }]);
        const tx = {
            machine: {
                findMany,
                updateMany: vi.fn(),
            },
            accountChange: { upsert: vi.fn() },
        } as any;

        await expect(
            matchMachineAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "matched" });

        findMany.mockResolvedValueOnce([{
            ...(await findMany())[0],
            metadataVersion: item.expectedMetadataVersion + 2,
        }]);
        await expect(
            matchMachineAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "mismatch" });

        findMany.mockResolvedValueOnce([]);
        await expect(
            matchMachineAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "matched" });
        expect(tx.machine.updateMany).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });
});
