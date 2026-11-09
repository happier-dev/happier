import { afterEach, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { inTxPostgresControlStatementMock, installDbModuleMock } from "@/app/api/testkit/dbMocks";

const transaction = vi.fn();
installDbModuleMock(() => ({ db: { $transaction: transaction } }));
const {
    acquireAccountSessionOwnerMetadataFenceInTx,
    acquireAccountSessionOwnerMetadataFencesInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} = await import("./accountSessionOwnerMetadataFence");
const { inTx } = await import("@/storage/inTx");
const { markAccountChanged } = await import("@/app/changes/markAccountChanged");

describe("acquireAccountSessionOwnerMetadataFenceInTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        restoreEnv(envSnapshot);
        transaction.mockReset();
    });

    it.each([
        {
            provider: "postgres",
            query: 'SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE',
        },
        {
            provider: "pglite",
            query: 'SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE',
        },
        {
            provider: "mysql",
            query: "SELECT `id` FROM `Account` WHERE `id` = ? FOR UPDATE",
        },
    ] as const)("locks exactly one Account row on $provider", async ({ provider, query }) => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const queryRawUnsafe = vi.fn(async () => [{ id: "account-1" }]);
        const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Tx;

        await acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1", "content");

        expect(queryRawUnsafe).toHaveBeenCalledWith(query, "account-1");
    });

    it("reserves the SQLite writer with a bound no-op update", async () => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "sqlite",
        });
        const executeRawUnsafe = vi.fn(async () => 1);
        const tx = { $executeRawUnsafe: executeRawUnsafe } as unknown as Tx;

        await acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1", "content");

        expect(executeRawUnsafe).toHaveBeenCalledWith(
            'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?',
            "account-1",
        );
    });

    it('uses the explicit maintenance client provider independently of the runtime provider', async () => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: 'postgres' });
        const executeRawUnsafe = vi.fn(async () => 1);
        const queryRawUnsafe = vi.fn(async () => [{ id: 'account-1' }]);
        const tx = { $executeRawUnsafe: executeRawUnsafe, $queryRawUnsafe: queryRawUnsafe } as unknown as Tx;
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, 'account-1', 'serializing', 'sqlite');
        expect(executeRawUnsafe).toHaveBeenCalledWith(
            'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?', 'account-1',
        );
        expect(queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("admits the sorted complete PostgreSQL audience and omits absent recipients", async () => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "postgres" });
        const queryRawUnsafe = vi.fn(async () => [{ id: "a" }, { id: "z" }]);
        const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Tx;

        await expect(acquireAccountSessionOwnerMetadataFencesInTx(tx, ["z", "absent", "a", "z"], "exclusive"))
            .resolves.toEqual(["a", "z"]);
        expect(queryRawUnsafe).toHaveBeenCalledWith(
            'SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE',
            ["a", "absent", "z"],
        );
    });

    it.each(["postgres", "pglite", "mysql"] as const)(
        "rejects a missing or duplicate Account row on %s",
        async (provider) => {
            applyEnvValues({
                HAPPY_DB_PROVIDER: undefined,
                HAPPIER_DB_PROVIDER: provider,
            });
            const queryRawUnsafe = vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    { id: "account-1" },
                    { id: "account-1" },
                ]);
            const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Tx;

            await expect(
                acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1", "exclusive"),
            ).rejects.toBeInstanceOf(
                AccountSessionOwnerMetadataFenceAccountNotFoundError,
            );
            await expect(
                acquireAccountSessionOwnerMetadataFenceInTx(tx, "account-1", "exclusive"),
            ).rejects.toThrow("exactly one Account row");
        },
    );

    it("rejects a missing Account row on SQLite", async () => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "sqlite",
        });
        const executeRawUnsafe = vi.fn(async () => 0);
        const tx = { $executeRawUnsafe: executeRawUnsafe } as unknown as Tx;

        await expect(
            acquireAccountSessionOwnerMetadataFenceInTx(tx, "missing-account", "content"),
        ).rejects.toBeInstanceOf(
            AccountSessionOwnerMetadataFenceAccountNotFoundError,
        );
    });

    it.each(["postgres", "mysql"] as const)("refuses a nested lower-id audience before issuing its late %s lock", async provider => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: provider });
        const admissionSql = vi.fn(async () => [{ id: "z" }]);
        const reserveWriter = vi.fn(async (_sql: string, ..._args: unknown[]) => 1);
        const writeResource = vi.fn(async () => ({ id: "session" }));
        transaction.mockImplementationOnce(async work => work({ ...inTxPostgresControlStatementMock,
            $queryRawUnsafe: admissionSql,
            $executeRawUnsafe: async (sql: string, ...args: unknown[]) => sql.startsWith("SET LOCAL")
                ? inTxPostgresControlStatementMock.$executeRawUnsafe(sql, ...args) : reserveWriter(sql, ...args),
            session: { update: writeResource },
        }));
        await inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFencesInTx(tx, ["z"], "content");
            await tx.session.update({ where: { id: "session" }, data: { seq: { increment: 1 } } });
            await expect(acquireAccountSessionOwnerMetadataFencesInTx(tx, ["z", "a"], "content"))
                .rejects.toMatchObject({ reason: "transaction-account-audience-changed" });
        });
        expect(writeResource).toHaveBeenCalledOnce();
        expect(admissionSql).toHaveBeenCalledOnce();
    });

    it.each((["postgres", "mysql", "sqlite"] as const).flatMap(provider => ([
        ["content", "serializing"], ["serializing", "exclusive"], ["exclusive", "serializing"],
    ] as const).map(([entry, requested]) => ({ provider, entry, requested }))))("checks $entry to $requested admission strength on $provider", async ({ provider, entry, requested }) => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: provider });
        const admissionSql = vi.fn(async () => [{ id: "a" }]);
        const reserveWriter = vi.fn(async (_sql: string, ..._args: unknown[]) => 1);
        transaction.mockImplementationOnce(async work => work({ ...inTxPostgresControlStatementMock,
            $queryRawUnsafe: admissionSql,
            $executeRawUnsafe: async (sql: string, ...args: unknown[]) => sql.startsWith("SET LOCAL")
                ? inTxPostgresControlStatementMock.$executeRawUnsafe(sql, ...args) : reserveWriter(sql, ...args),
        }));
        await inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFencesInTx(tx, ["a"], entry);
            const nested = acquireAccountSessionOwnerMetadataFencesInTx(tx, ["a"], requested);
            if (provider === "postgres" && entry !== "exclusive") await expect(nested).rejects.toMatchObject({ reason: "transaction-account-audience-changed" });
            else await expect(nested).resolves.toEqual(["a"]);
        });
        expect(provider === "sqlite" ? reserveWriter : admissionSql).toHaveBeenCalledTimes(provider === "sqlite" ? 2 : 1);
    });

    it("does not remember an absent row as a held admission", async () => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "postgres" });
        const admissionSql = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: "a" }]);
        transaction.mockImplementationOnce(async work => work({ ...inTxPostgresControlStatementMock,
            $queryRawUnsafe: admissionSql,
        }));
        await inTx(async tx => {
            await expect(acquireAccountSessionOwnerMetadataFencesInTx(tx, ["a"], "content")).resolves.toEqual([]);
            await expect(acquireAccountSessionOwnerMetadataFencesInTx(tx, ["a"], "content")).resolves.toEqual(["a"]);
            await expect(acquireAccountSessionOwnerMetadataFencesInTx(tx, ["a"], "content")).resolves.toEqual(["a"]);
        });
        expect(admissionSql).toHaveBeenCalledTimes(2);
    });

    it("refuses a newly queued terminal recipient before any terminal Account SQL", async () => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "mysql", HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const admissionSql = vi.fn(async () => [{ id: "z" }]);
        const allocate = vi.fn(async () => ({ seq: 1 }));
        const persist = vi.fn(async () => ({}));
        transaction.mockImplementationOnce(async work => work({
            $queryRawUnsafe: admissionSql,
            account: { update: allocate }, accountChange: { upsert: persist },
        }));
        await expect(inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFencesInTx(tx, ["z"], "content");
            // A publisher can queue an audience without calling admission again.
            await markAccountChanged(tx, { accountId: "a", entityId: "projection", kind: "account" });
        })).rejects.toMatchObject({ code: "database_transaction_conflict_exhausted",
            cause: { reason: "transaction-account-audience-changed" } });
        expect(admissionSql).toHaveBeenCalledOnce();
        expect(allocate).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
    });

    it("keeps valid foreign-recipient publication on SQLite's single writer", async () => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "sqlite", HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const reserveWriter = vi.fn(async () => 1);
        const allocate = vi.fn(async () => ({ seq: 1 }));
        const persist = vi.fn(async () => ({}));
        transaction.mockImplementationOnce(async work => work({ $executeRawUnsafe: reserveWriter,
            account: { update: allocate }, accountChange: { upsert: persist } }));
        await expect(inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFencesInTx(tx, ["owner"], "content");
            await markAccountChanged(tx, { accountId: "viewer", entityId: "projection", kind: "account" });
        })).resolves.toBeUndefined();
        expect(reserveWriter).toHaveBeenCalledOnce();
        expect(allocate).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledOnce();
    });
});
