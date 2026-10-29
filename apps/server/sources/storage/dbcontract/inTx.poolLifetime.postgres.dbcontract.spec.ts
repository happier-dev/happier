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
    ])("refreshes only a changed SQL constraint for Q=$queries reads (existing timeout: $configuredMs ms)", async ({ queries, configuredMs }) => {
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
            const expectedRefreshes = configuredMs === 0 ? queries : 0;
            expect(measured.refreshes).toBe(expectedRefreshes);
            expect(measured.operations).toBe(queries + 2 + expectedRefreshes);
        } finally {
            await db.$executeRaw`SELECT set_config('statement_timeout', ${original}, false)`;
        }
    });

    it("charges completed SQL time to the next raw statement", async () => {
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
        expect(budgets.after).toBeLessThan(budgets.before);
    });

    it.each([
        { concurrent: false, refresh: "remaining" }, { concurrent: true, refresh: "remaining" },
        { concurrent: false, refresh: "once" }, { concurrent: true, refresh: "once" },
    ])("charges earlier SQL before a later lock wait (Promise.all: $concurrent, refresh: $refresh)", async ({ concurrent, refresh }) => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const budget = readDatabaseTransactionConfigFromEnv(process.env, "postgres");
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const holderReady = new Promise<number>(resolve => { ready = resolve; });
        const holder = observer.$transaction(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid() AS pid FROM "Account" WHERE id = ${account.id} FOR UPDATE
            `;
            ready(pid);
            await released;
        }, { timeout: budget.timeoutMs + budget.timeoutMs + budget.maxWaitMs });
        const holderOutcome = Promise.allSettled([holder]);
        let transactionSettled = false;
        let settledAfterMs: number | undefined;
        let committedCallback = false;
        let waiterPid: number | undefined;
        let readyWaiter!: () => void;
        const waiterReady = new Promise<void>(resolve => { readyWaiter = resolve; });
        let waitingOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let snapshot: { settled: boolean; activeTransaction: boolean } | undefined;
        const workMs = Math.floor(budget.timeoutMs * 2 / 3);
        let startedAtMs = 0;
        const transaction = db.$transaction;
        let appliedRefreshes = 0;
        if (refresh === "once") {
            // Negative control at the actual SQL transport: simulate setting
            // the budget once without altering inTx, Prisma or the lock owner.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, {
                    get(owner, property) {
                        if (property !== "$executeRawUnsafe") return Reflect.get(owner, property, owner);
                        return (sql: string, ...values: unknown[]) => {
                            if (sql.startsWith("SET LOCAL statement_timeout = ") && ++appliedRefreshes > 1) return Promise.resolve(0);
                            return owner.$executeRawUnsafe(sql, ...values);
                        };
                    },
                })), ...args.slice(1)]);
            } });
        }
        try {
            const holderPid = await Promise.race([holderReady, holder.then(() => { throw new Error("Holder exited before rendezvous"); })]);
            startedAtMs = Date.now();
            const waiting = inTx(async tx => {
                [{ pid: waiterPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                afterTx(tx, () => { committedCallback = true; });
                const earlier = tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(${workMs / 1_000}::double precision)`;
                const update = tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                if (concurrent) await Promise.all([earlier.then(() => { readyWaiter(); }), update]);
                else {
                    await earlier;
                    readyWaiter();
                    await update;
                }
            }, { transactionClass: "test-expired-pool-waiter" });
            waitingOutcome = Promise.allSettled([waiting]).finally(() => {
                transactionSettled = true;
                settledAfterMs = Date.now() - startedAtMs;
            });
            await Promise.race([waiterReady, waiting]);
            while (!transactionSettled) {
                const [{ blocked }] = await observer.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT ${holderPid}::int = ANY(pg_blocking_pids(${waiterPid!}::int)) AS blocked
                `;
                if (blocked) break;
            }
            // The first statement and observation each use two thirds of the
            // existing budget. A fresh full-budget timeout on the later UPDATE
            // still holds the slot here; a remaining-budget timeout has settled.
            await new Promise(resolve => setTimeout(resolve, workMs));
            const [{ active }] = await observer.$queryRaw<Array<{ active: boolean }>>`
                SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${waiterPid!} AND xact_start IS NOT NULL) AS active
            `;
            snapshot = { settled: transactionSettled, activeTransaction: active };
            console.info("transaction-budget-observation", {
                concurrent, refresh, timeoutMs: budget.timeoutMs, earlierSqlMs: workMs,
                observedAfterMs: Date.now() - startedAtMs, settledAfterMs, ...snapshot,
            });
            if (snapshot.settled && !snapshot.activeTransaction) {
                // The only application pool slot is usable while the independent
                // holder is still live, not merely after its lock is released.
                expect(await db.$queryRaw<Array<{ value: number }>>`SELECT 1::int AS value`).toEqual([{ value: 1 }]);
            }
        } finally {
            db.$transaction = transaction;
            release();
            await holderOutcome;
            if (waitingOutcome) await waitingOutcome;
        }
        try {
            expect(snapshot).toEqual(refresh === "once"
                ? { settled: false, activeTransaction: true }
                : { settled: true, activeTransaction: false });
            expect((await waitingOutcome!)[0].status).toBe("rejected");
            expect(committedCallback).toBe(false);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 0 });
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });

    describe("an expired transaction never keeps waiting for or holding a lock", () => {
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

    it("preserves lazy and fluent Prisma queries, delegate identity, raw methods and after-commit effects", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        let published = false;
        try {
            await inTx(async tx => {
                expect(tx.account).toBe(tx.account);
                expect(tx.account.update).toBe(tx.account.update);
                expect(tx.$queryRaw).toBe(tx.$queryRaw);
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
            }, { transactionClass: "test-remaining-budget-prisma-contract" });
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
