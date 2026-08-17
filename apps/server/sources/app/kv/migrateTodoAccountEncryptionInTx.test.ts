import { describe, expect, it, vi } from "vitest";

import {
    matchTodoAccountEncryptionMigrationPostStateInTx,
    migrateTodoAccountEncryptionInTx,
    TodoAccountEncryptionMigrationConflictError,
} from "./migrateTodoAccountEncryptionInTx";

describe("migrateTodoAccountEncryptionInTx", () => {
    it("rejects a foreign or incomplete Todo inventory before mutation", async () => {
        const mutate = vi.fn();
        await expect(migrateTodoAccountEncryptionInTx({
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

        await expect(migrateTodoAccountEncryptionInTx({
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

        await expect(migrateTodoAccountEncryptionInTx({
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
        const update = vi.fn();

        await expect(migrateTodoAccountEncryptionInTx({
            tx: {
                userKVStore: {
                    findMany: vi.fn(async () => [{
                        key: "todo.index",
                        version: 2,
                        value: new TextEncoder().encode("released-ciphertext"),
                    }]),
                    findUnique: vi.fn(async () => ({
                        key: "todo.index",
                        version: 3,
                        value: new TextEncoder().encode("concurrent-ciphertext"),
                    })),
                    update,
                },
            } as any,
            accountId: "account-1",
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
            TodoAccountEncryptionMigrationConflictError,
        );
        expect(update).not.toHaveBeenCalled();
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
            matchTodoAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
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
            matchTodoAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "migrate", items: [item] },
            }),
        ).resolves.toEqual({ status: "mismatch" });

        findMany.mockResolvedValueOnce([]);
        await expect(
            matchTodoAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: "account-1",
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        ).resolves.toEqual({ status: "matched" });
        expect(tx.userKVStore.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });
});
