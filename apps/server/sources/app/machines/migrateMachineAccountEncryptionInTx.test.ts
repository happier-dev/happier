import { describe, expect, it, vi } from "vitest";

import {
    matchMachineAccountEncryptionMigrationPostStateInTx,
} from "./migrateMachineAccountEncryptionInTx";

describe("migrateMachineAccountEncryptionInTx", () => {
    it("matches the exact complete post-state and assert-empty read-only", async () => {
        const item = {
            machineId: "machine-1",
            expectedMetadataVersion: 2,
            expectedDaemonStateVersion: 3,
            expectedDataEncryptionKey: null,
            metadata: "eyJ0IjoicGxhaW4iLCJ2Ijp7Imhvc3QiOiJxYSJ9fQ==",
            daemonState: null,
            dataEncryptionKey: "eyJ0IjoicGxhaW4iLCJ2IjpudWxsfQ==",
            contentPublicKeyFingerprint: null,
        } as const;
        const findMany = vi.fn(async () => [{
            id: item.machineId,
            kind: "persistent" as const,
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
