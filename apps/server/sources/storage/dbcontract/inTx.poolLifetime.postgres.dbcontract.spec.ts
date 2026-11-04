import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDatabaseTransactionConfigFromEnv } from "@/config/databaseTransactions";
import { db, initDbPostgres } from "@/storage/db";
import { afterTx, inTx, TransactionDeadlineExceededError, type Tx } from "@/storage/inTx";
import { createDbMaintenanceClient, getDbProviderFromEnv, type PrismaClientType } from "@/storage/prisma";
import { observeLazyPrismaQuery } from "@/app/changes/accountPublicationContention.testkit";

/** Count ORM operations at the real disposable PostgreSQL transport, including controls. */
async function measureTransactionOperations<T>(run: () => Promise<T>) {
    const counts = { operations: 0, refreshes: 0 };
    const original = db.$transaction;
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, {
            get(owner, property) {
                const method: unknown = Reflect.get(owner, property, owner);
                if (typeof property !== "string" || !property.startsWith("$") || typeof method !== "function") return method;
                return (...values: unknown[]) => observeLazyPrismaQuery(Reflect.apply(method, owner, values), () => ({
                    started() {
                        counts.operations++;
                        if (property === "$executeRawUnsafe" && typeof values[0] === "string"
                            && values[0].startsWith("SET LOCAL statement_timeout = ")) counts.refreshes++;
                    },
                    settled() {},
                }));
            },
        })), ...args.slice(1)]);
    } });
    try { return { result: await run(), ...counts }; }
    finally { db.$transaction = original; }
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL transaction connection lifetime", () => {
    let observer: PrismaClientType;
    let originalDatabaseUrl: string | undefined;
    const originalMaxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || supplied !== process.env.DATABASE_URL) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        originalDatabaseUrl = supplied;
        // Observe one attempt's connection lifetime. Confirmed Prisma expiry
        // may otherwise replay the callback and replace the observed backend
        // with a new transaction, which is a distinct retry-owner contract.
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        const url = new URL(supplied);
        // One isolated slot makes a held connection observable. This is a test
        // topology, not a change to the server's pool configuration.
        url.searchParams.set("connection_limit", "1");
        process.env.DATABASE_URL = url.toString();
        // PID observations must use a session connection: a transaction-pool
        // observer can reuse the inspected backend and see its own transaction.
        observer = await createDbMaintenanceClient("postgres", process.env.HAPPIER_TEST_POSTGRES_DIRECT_DATABASE_URL ?? supplied);
        initDbPostgres();
        await Promise.all([db.$connect(), observer.$connect()]);
        connected = true;
    });

    afterAll(async () => {
        if (connected) await Promise.all([db.$disconnect(), observer.$disconnect()]);
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
        if (originalMaxRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = originalMaxRetries;
    });

    it.each([
        { queries: 1, configuredMs: 0 }, { queries: 16, configuredMs: 0 },
        { queries: 1, configuredMs: 1_000 }, { queries: 16, configuredMs: 1_000 },
    ])("sets at most one SQL budget for Q=$queries reads (existing timeout: $configuredMs ms)", async ({ queries, configuredMs }) => {
        const [{ setting: original }] = await db.$queryRaw<Array<{ setting: string }>>`SELECT current_setting('statement_timeout') AS setting`;
        try {
            // This suite owns one disposable backend. An existing SQL limit
            // protects each query without reapplying the identical LOCAL value.
            await db.$executeRaw`SELECT set_config('statement_timeout', ${`${configuredMs}ms`}, false)`;
            const measured = await measureTransactionOperations(() => inTx(async tx => {
                for (let index = 0; index < queries; index++) {
                    const [row] = await tx.$queryRaw<Array<{ value: number; readOnly: string; milliseconds: number }>>`
                        SELECT 1::int AS value, current_setting('transaction_read_only') AS "readOnly",
                            (EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000)::int AS milliseconds
                        FROM pg_sleep(0.005)
                    `;
                    expect(row).toMatchObject({ value: 1, readOnly: "on" });
                    expect(row.milliseconds).toBeGreaterThan(0);
                    expect(row.milliseconds).toBeLessThanOrEqual(configuredMs || 10_000);
                }
            }, { readOnly: true, timeoutMs: 10_000, transactionClass: "test-unchanged-sql-budget-cost" }));
            console.info("TRANSACTION_BUDGET_COST", { queries, configuredMs, ...measured });
            const expectedRefreshes = configuredMs === 0 ? 1 : 0;
            expect(measured.refreshes).toBe(expectedRefreshes);
            expect(measured.operations).toBe(queries + 2 + expectedRefreshes);
        } finally {
            await db.$executeRaw`SELECT set_config('statement_timeout', ${original}, false)`;
        }
    });

    it("keeps the initial SQL budget across later raw statements", async () => {
        const readBudget = (tx: Tx) => tx.$queryRaw<Array<{ milliseconds: number }>>`
            SELECT (EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000)::int AS milliseconds
        `;
        const budgets = await inTx(async tx => {
            const [before] = await readBudget(tx);
            await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(0.05)`;
            const [after] = await readBudget(tx);
            return { before: before.milliseconds, after: after.milliseconds };
        });
        expect(budgets.after).toBeGreaterThan(0);
        expect(budgets.after).toBe(budgets.before);
    });

    it.each([false, true])("settles a later lock wait under the initial budget and releases its connection (Promise.all: %s)", async concurrent => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const budget = readDatabaseTransactionConfigFromEnv(process.env, "postgres");
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const holderReady = new Promise<void>(resolve => { ready = resolve; });
        const holder = observer.$transaction(async tx => {
            await tx.$queryRaw`SELECT 1 FROM "Account" WHERE id = ${account.id} FOR UPDATE`;
            ready();
            await released;
        }, { timeout: budget.timeoutMs + budget.timeoutMs + budget.maxWaitMs });
        const holderOutcome = Promise.allSettled([holder]);
        let committedCallback = false;
        let waiterPid!: number;
        try {
            await Promise.race([holderReady, holder.then(() => { throw new Error("Holder exited before rendezvous"); })]);
            await expect(inTx(async tx => {
                [{ pid: waiterPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                afterTx(tx, () => { committedCallback = true; });
                const earlier = tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(${budget.timeoutMs * 2 / 3_000}::double precision)`;
                const update = tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                if (concurrent) await Promise.all([earlier, update]);
                else { await earlier; await update; }
            }, { transactionClass: "test-fixed-budget-late-waiter" })).rejects.toBeInstanceOf(TransactionDeadlineExceededError);
            // The fixed statement budget can outlive Prisma's attempt deadline.
            // It still cancels the wait, rolls back, and releases the only slot
            // without waiting for the independent lock holder to finish.
            expect(committedCallback).toBe(false);
            expect(await observer.$queryRaw<Array<{ active: boolean }>>`
                SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${waiterPid} AND xact_start IS NOT NULL) AS active
            `).toEqual([{ active: false }]);
            expect(await db.$queryRaw<Array<{ value: number }>>`SELECT 1::int AS value`).toEqual([{ value: 1 }]);
        } finally {
            release();
            await holderOutcome;
            await db.account.delete({ where: { id: account.id } });
        }
    });

    describe("native transaction and fixed statement timeouts release locks", () => {
        const originalTimeout = process.env.HAPPIER_DB_TX_TIMEOUT_MS;
        beforeAll(() => { process.env.HAPPIER_DB_TX_TIMEOUT_MS = "1500"; });
        afterAll(() => {
            if (originalTimeout === undefined) delete process.env.HAPPIER_DB_TX_TIMEOUT_MS;
            else process.env.HAPPIER_DB_TX_TIMEOUT_MS = originalTimeout;
        });

        const readBackend = (pid: number) => observer.$queryRaw<Array<{ inTransaction: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND xact_start IS NOT NULL) AS "inTransaction"
        `;

        it("ends a lock wait at the budget as a rolled-back timeout and frees the backend while the holder still holds", async () => {
            const account = await db.account.create({ data: { publicKey: randomUUID() } });
            let release!: () => void;
            const released = new Promise<void>(resolve => { release = resolve; });
            let holding!: () => void;
            const holderReady = new Promise<void>(resolve => { holding = resolve; });
            const holder = observer.$transaction(async tx => {
                await tx.$queryRaw`SELECT 1 FROM "Account" WHERE id = ${account.id} FOR UPDATE`;
                holding();
                await released;
            }, { timeout: 60_000 });
            const holderOutcome = Promise.allSettled([holder]);
            try {
                await holderReady;
                let waiterPid!: number;
                const startedAtMs = Date.now();
                const outcome = await Promise.allSettled([inTx(async tx => {
                    [{ pid: waiterPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                }, { transactionClass: "test-lock-wait-budget" })]);
                const elapsedMs = Date.now() - startedAtMs;
                expect(outcome[0].status).toBe("rejected");
                expect((outcome[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransactionDeadlineExceededError);
                expect(elapsedMs).toBeLessThan(1500 + 3_000);
                expect(await readBackend(waiterPid)).toEqual([{ inTransaction: false }]);
                expect(await db.$queryRaw<Array<{ value: number }>>`SELECT 1::int AS value`).toEqual([{ value: 1 }]);
            } finally {
                release();
                await holderOutcome;
                await db.account.delete({ where: { id: account.id } });
            }
        });

        it("reports a statement cancelled by an earlier SQL budget as a rolled-back timeout", async () => {
            const account = await db.account.create({ data: { publicKey: randomUUID() } });
            const [{ setting: original }] = await db.$queryRaw<Array<{ setting: string }>>`SELECT current_setting('statement_timeout') AS setting`;
            let release!: () => void;
            const released = new Promise<void>(resolve => { release = resolve; });
            let holding!: () => void;
            const holderReady = new Promise<void>(resolve => { holding = resolve; });
            const holder = observer.$transaction(async tx => {
                await tx.$queryRaw`SELECT 1 FROM "Account" WHERE id = ${account.id} FOR UPDATE`;
                holding();
                await released;
            }, { timeout: 60_000 });
            const holderOutcome = Promise.allSettled([holder]);
            try {
                await holderReady;
                // The pool has one connection, so this stricter database
                // setting reaches the transaction: SQL ends before Prisma's timer.
                await db.$executeRaw`SELECT set_config('statement_timeout', '500ms', false)`;
                const startedAtMs = Date.now();
                await expect(inTx(async tx => {
                    await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                }, { transactionClass: "test-statement-budget-cancel" })).rejects.toBeInstanceOf(TransactionDeadlineExceededError);
                expect(Date.now() - startedAtMs).toBeLessThan(1_500);
            } finally {
                await db.$executeRaw`SELECT set_config('statement_timeout', ${original}, false)`;
                release();
                await holderOutcome;
                await db.account.delete({ where: { id: account.id } });
            }
        });

        it("releases a lock whose callback never finishes once the budget expires", async () => {
            const account = await db.account.create({ data: { publicKey: randomUUID() } });
            let holderPid!: number;
            let locked!: () => void;
            const holderLocked = new Promise<void>(resolve => { locked = resolve; });
            const hung = Promise.allSettled([inTx(async tx => {
                [{ pid: holderPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                locked();
                await new Promise<never>(() => {});
            }, { transactionClass: "test-hung-lock-holder" })]);
            try {
                await holderLocked;
                const startedAtMs = Date.now();
                // Another connection waits for the row; it can proceed only
                // after the hung transaction's database backend has ended.
                const [{ seq }] = await observer.$transaction(async tx => {
                    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '20s'");
                    return await tx.$queryRaw<Array<{ seq: number }>>`SELECT seq FROM "Account" WHERE id = ${account.id} FOR UPDATE`;
                }, { timeout: 30_000 });
                expect(seq).toBe(0);
                expect(Date.now() - startedAtMs).toBeLessThan(1500 + 3_000);
                expect(await readBackend(holderPid)).toEqual([{ inTransaction: false }]);
            } finally {
                await Promise.race([hung, new Promise(resolve => setTimeout(resolve, 5_000))]);
                await db.account.delete({ where: { id: account.id } });
            }
        });
    });

    it("preserves lazy and fluent Prisma queries, raw methods and after-commit effects", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        let published = false;
        try {
            await inTx(async tx => {
                expect(tx.account.fields.seq.name).toBe("seq");
                const lazy = tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } }, select: { seq: true } });
                expect(typeof lazy.then).toBe("function");
                expect(await observer.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 0 });
                expect(await lazy.finally(() => {})).toEqual({ seq: 1 });
                expect(await lazy).toEqual({ seq: 1 });
                expect(await tx.account.findUniqueOrThrow({ where: { id: account.id } }).Session({ select: { id: true } })).toEqual([{ id: session.id }]);
                const [tagged, unsafe, executed] = await Promise.all([
                    tx.$queryRaw<Array<{ seq: number }>>`SELECT seq FROM "Account" WHERE id = ${account.id}`,
                    tx.$queryRawUnsafe<Array<{ seq: number }>>('SELECT seq FROM "Account" WHERE id = $1', account.id),
                    tx.$executeRaw`UPDATE "Account" SET seq = seq + 1 WHERE id = ${account.id}`,
                ]);
                expect(tagged).toEqual([{ seq: 1 }]);
                expect(unsafe).toEqual(tagged);
                expect(executed).toBe(1);
                expect(published).toBe(false);
                afterTx(tx, () => { published = true; });
            }, { transactionClass: "test-fixed-budget-prisma-contract" });
            expect(published).toBe(true);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 2 });
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each([1_000, 7_500, 60_000, 3_600_000, 86_400_000])("honors the stricter SQL or transaction deadline and restores %i ms after commit", async configuredMs => {
        const [{ setting: original }] = await db.$queryRaw<Array<{ setting: string }>>`SELECT current_setting('statement_timeout') AS setting`;
        const expectedMs = Math.min(configuredMs, readDatabaseTransactionConfigFromEnv(process.env, "postgres").timeoutMs);
        try {
            await db.$executeRaw`SELECT set_config('statement_timeout', ${`${configuredMs}ms`}, false)`;
            const rows = await inTx(tx => tx.$queryRaw<Array<{ milliseconds: number }>>`
                SELECT (EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000)::int AS milliseconds
            `);
            expect(rows[0].milliseconds).toBeGreaterThan(0);
            expect(rows[0].milliseconds).toBeLessThanOrEqual(expectedMs);
            expect(await db.$queryRaw<Array<{ milliseconds: number }>>`
                SELECT (EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000)::int AS milliseconds
            `).toEqual([{ milliseconds: configuredMs }]);
        } finally {
            await db.$executeRaw`SELECT set_config('statement_timeout', ${original}, false)`;
        }
    });
});
