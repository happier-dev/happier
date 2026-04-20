import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const delay = vi.fn(async () => {});
vi.mock("@/utils/runtime/delay", () => ({ delay }));

const txDbMocks = createDbMocks({
    account: ["update"],
    accountChange: ["upsert"],
} as const);

const transaction = vi.fn(async <T>(fn: (tx: typeof txDbMocks.db) => Promise<T>, _opts?: unknown): Promise<T> => await fn(txDbMocks.db));

installDbModuleMock(() => ({
    db: {
        $transaction: transaction,
    },
}));

describe("markAccountChangedAfterCommit", () => {
    beforeEach(() => {
        vi.resetModules();
        txDbMocks.reset();
        transaction.mockReset();
        transaction.mockImplementation(async <T>(fn: (tx: typeof txDbMocks.db) => Promise<T>, _opts?: unknown): Promise<T> => await fn(txDbMocks.db));
        delay.mockClear();
        process.env.HAPPIER_DB_PROVIDER = "postgres";
        txDbMocks.db.account.update.mockResolvedValue({ seq: 9 });
        txDbMocks.db.accountChange.upsert.mockResolvedValue({});
    });

    it("runs account change tracking in its own read-committed transaction for postgres", async () => {
        const { markAccountChangedAfterCommit } = await import("./markAccountChangedAfterCommit");

        const cursor = await markAccountChangedAfterCommit({
            accountId: "a1",
            kind: "session",
            entityId: "s1",
        });

        expect(cursor).toBe(9);
        expect(transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "ReadCommitted" }));
        expect(txDbMocks.db.account.update).toHaveBeenCalled();
        expect(txDbMocks.db.accountChange.upsert).toHaveBeenCalled();
    });

    it("retries retryable conflicts before succeeding", async () => {
        const conflict = Object.assign(new Error("retry me"), { code: "P2034" });
        transaction
            .mockRejectedValueOnce(conflict)
            .mockImplementationOnce(async <T>(fn: (tx: typeof txDbMocks.db) => Promise<T>, _opts?: unknown): Promise<T> => await fn(txDbMocks.db));

        const { markAccountChangedAfterCommit } = await import("./markAccountChangedAfterCommit");

        const cursor = await markAccountChangedAfterCommit({
            accountId: "a1",
            kind: "session",
            entityId: "s1",
        });

        expect(cursor).toBe(9);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delay).toHaveBeenCalledTimes(1);
    });

    it("retries raw postgres serialization aborts before succeeding", async () => {
        transaction
            .mockRejectedValueOnce(new Error("could not serialize access due to read/write dependencies among transactions"))
            .mockImplementationOnce(async <T>(fn: (tx: typeof txDbMocks.db) => Promise<T>, _opts?: unknown): Promise<T> => await fn(txDbMocks.db));

        const { markAccountChangedAfterCommit } = await import("./markAccountChangedAfterCommit");

        const cursor = await markAccountChangedAfterCommit({
            accountId: "a1",
            kind: "session",
            entityId: "s1",
        });

        expect(cursor).toBe(9);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delay).toHaveBeenCalledTimes(1);
    });
});
