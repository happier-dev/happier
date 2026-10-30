import { describe, expect, it, vi } from "vitest";

import {
    matchAccountJsonKvEncryptionMigrationPostStateInTx,
    migrateAccountJsonKvEncryptionInTx,
    AccountJsonKvEncryptionMigrationConflictError,
} from "./migrateAccountJsonKvEncryptionInTx";

describe("migrateAccountJsonKvEncryptionInTx", () => {
    it('requires every active workspace row while ignoring tombstones and matches exact replay without writes', async () => {
        const key = 'workspace:tabs:v1';
        const value = new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { v: 1, tabsById: {}, order: [], pairs: [] } }));
        // Prisma is the boundary: exercise the real census and replay owners.
        const tx = { userKVStore: { findMany: vi.fn(async () => [
            { key, version: 5, value },
            { key: 'workspace:handoff-tabs:v1:deleted:window', version: 9, value: null },
        ]), update: vi.fn() } } as unknown as Parameters<typeof migrateAccountJsonKvEncryptionInTx>[0]['tx'];
        const params = { tx, accountId: 'account-1', namespace: 'workspace' as const, fromMode: 'e2ee' as const, toMode: 'plain' as const };
        await expect(migrateAccountJsonKvEncryptionInTx({ ...params, directive: { action: 'assert_empty' } })).resolves.toEqual({ status: 'not_empty' });
        await expect(migrateAccountJsonKvEncryptionInTx({ ...params, directive: { action: 'migrate', items: [] } })).resolves.toEqual({ status: 'migration_incomplete' });
        const item = { key, expectedVersion: 4, value: Buffer.from(value).toString('base64') };
        await expect(matchAccountJsonKvEncryptionMigrationPostStateInTx({ ...params, directive: { action: 'migrate', items: [item] } })).resolves.toEqual({ status: 'matched' });
        await expect(matchAccountJsonKvEncryptionMigrationPostStateInTx({ ...params, directive: { action: 'migrate', items: [{ ...item, expectedVersion: 3 }] } })).resolves.toEqual({ status: 'mismatch' });
        expect(tx.userKVStore.update).not.toHaveBeenCalled();
    });
    it("rejects a foreign or incomplete Todo inventory before mutation", async () => {
        const mutate = vi.fn();
        await expect(migrateAccountJsonKvEncryptionInTx({
            tx: {
                userKVStore: {
                    findMany: vi.fn(async () => [{
                        key: "todo.index",
                        version: 2,
                        value: new TextEncoder().encode(
                            "released-ciphertext",
                        ),
                    }]),
                },
            } as any,
            accountId: "account-1",
            namespace: "todo",
            fromMode: "e2ee",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    key: "todo.other",
                    expectedVersion: 2,
                    value: "value",
                }],
            },
            mutate,
        })).resolves.toEqual({ status: "migration_incomplete" });
        expect(mutate).not.toHaveBeenCalled();
    });

    it("delegates an exact plain replacement to the canonical KV mutation owner", async () => {
        const plainValue = Buffer.from(
            JSON.stringify({ t: "plain", v: { undoneOrder: [] } }),
            "utf8",
        ).toString("base64");
        const mutate = vi.fn(async () => ({
            success: true as const,
            results: [{ key: "todo.index", version: 3 }],
        }));

        await expect(migrateAccountJsonKvEncryptionInTx({
            tx: {
                userKVStore: {
                    findMany: vi.fn(async () => [{
                        key: "todo.index",
                        version: 2,
                        value: new TextEncoder().encode(
                            "released-ciphertext",
                        ),
                    }]),
                },
            } as any,
            accountId: "account-1",
            namespace: "todo",
            fromMode: "e2ee",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    key: "todo.index",
                    expectedVersion: 2,
                    value: plainValue,
                }],
            },
            mutate,
        })).resolves.toEqual({ status: "applied" });

        expect(mutate).toHaveBeenCalledWith([{
            key: "todo.index",
            version: 2,
            value: plainValue,
        }]);
    });

    it("refuses a transition inventory whose persisted Todo mode does not match fromMode", async () => {
        const plainValue = Buffer.from(
            JSON.stringify({ t: "plain", v: { undoneOrder: [] } }),
            "utf8",
        ).toString("base64");
        const mutate = vi.fn();

        await expect(migrateAccountJsonKvEncryptionInTx({
            tx: {
                userKVStore: {
                    findMany: vi.fn(async () => [{
                        key: "todo.index",
                        version: 2,
                        value: Buffer.from(plainValue, "base64"),
                    }]),
                },
            } as any,
            accountId: "account-1",
            namespace: "todo",
            fromMode: "e2ee",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    key: "todo.index",
                    expectedVersion: 2,
                    value: plainValue,
                }],
            },
            mutate,
        })).resolves.toEqual({ status: "invalid_content" });
        expect(mutate).not.toHaveBeenCalled();
    });

    it("reports a stale Todo CAS as an Account migration conflict", async () => {
        const plainValue = Buffer.from(
            JSON.stringify({ t: "plain", v: { undoneOrder: [] } }),
            "utf8",
        ).toString("base64");
        const updateMany = vi.fn();

        await expect(migrateAccountJsonKvEncryptionInTx({
            tx: {
                userKVStore: {
                    findMany: vi.fn()
                    .mockResolvedValueOnce([{
                        key: "todo.index",
                        version: 2,
                        value: new TextEncoder().encode("released-ciphertext"),
                    }])
                    .mockResolvedValueOnce([{
                        key: "todo.index",
                        version: 3,
                        value: new TextEncoder().encode("concurrent-ciphertext"),
                    }]),
                    updateMany,
                },
            } as any,
            accountId: "account-1",
            namespace: "todo",
            fromMode: "e2ee",
            toMode: "plain",
            directive: {
                action: "migrate",
                items: [{
                    key: "todo.index",
                    expectedVersion: 2,
                    value: plainValue,
                }],
            },
        })).rejects.toBeInstanceOf(
            AccountJsonKvEncryptionMigrationConflictError,
        );
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("matches exact decoded Todo post-state and rejects version/set drift read-only", async () => {
        const valueBytes = new TextEncoder().encode(
            JSON.stringify({ t: "plain", v: { undoneOrder: [] } }),
        );
        const item = {
            key: "todo.index",
            expectedVersion: 2,
            value: Buffer.from(valueBytes).toString("base64"),
        } as const;
        const findMany = vi.fn(async () => [{
            key: item.key,
            version: item.expectedVersion + 1,
            value: valueBytes,
        }]);
        const tx = {
            userKVStore: {
                findMany,
                update: vi.fn(),
            },
            accountChange: { upsert: vi.fn() },
        } as any;

        await expect(
            matchAccountJsonKvEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
            namespace: "todo",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "matched" });

        findMany.mockResolvedValueOnce([{
            key: item.key,
            version: item.expectedVersion + 2,
            value: valueBytes,
        }]);
        await expect(
            matchAccountJsonKvEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
            namespace: "todo",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "mismatch" });

        findMany.mockResolvedValueOnce([]);
        await expect(
            matchAccountJsonKvEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
            namespace: "todo",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "matched" });
        expect(tx.userKVStore.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });
});
