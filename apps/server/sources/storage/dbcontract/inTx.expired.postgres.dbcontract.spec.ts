import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { afterTx, inTx, readPostgresTransactionSqlState, TransactionDeadlineExceededError, type Tx } from "@/storage/inTx";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL transaction retry policy", () => {
    let connected = false;
    const env = snapshotEnv();

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        applyEnvValues({ HAPPIER_DB_TX_MAX_RETRIES: "2", HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "0",
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0" });
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
        restoreEnv(env);
    });

    it.each([false, true])("shares the original operation deadline across real serialization attempts (caller deadline: %s)", async callerDeadline => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const committed: number[] = [];
        let attempts = 0;
        let conflict: unknown;
        const startedAtMs = Date.now();
        const deadlineAtMs = startedAtMs + 1_600;
        try {
            const outcome = await inTx(async tx => {
                const attempt = ++attempts;
                afterTx(tx, () => { committed.push(attempt); });
                await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                if (attempt === 1) {
                    await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                    await tx.$queryRaw`SELECT 1::int FROM pg_sleep(0.65)`;
                } else {
                    await tx.$queryRaw`SELECT 1::int FROM pg_sleep(1.1)`;
                }
                try {
                    return await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } }, select: { seq: true } });
                } catch (error) { conflict = error; throw error; }
            }, { isolationLevel: "Serializable", maxWaitMs: 200, timeoutMs: 1_400,
                ...(callerDeadline ? { deadlineAtMs } : {}), transactionClass: "test-original-retry-deadline" })
                .then(value => ({ value }), error => ({ error }));
            expect(conflict).toMatchObject({ code: "P2034" });
            expect(outcome).toMatchObject({ error: { name: "TransactionDeadlineExceededError" } });
            expect(attempts).toBe(2);
            expect(committed).toEqual([]);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 1 });
            console.info("RETRYPOLICY_ORIGINAL_BUDGET", { callerDeadline, attempts, elapsedMs: Date.now() - startedAtMs });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it.each([false, true])("settles native expired P2028 without another attempt (caller deadline: %s)", async callerDeadline => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const transaction = db.$transaction;
        let attempts = 0;
        let nativeFailure: unknown;
        const published: number[] = [];
        try {
            // Fault only at the real Prisma boundary: callback SQL completes,
            // then the native timer rolls back before the commit can happen.
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    const options = args[1];
                    if (typeof callback !== "function" || !options || typeof options !== "object"
                        || !("timeout" in options) || typeof options.timeout !== "number") {
                        return Reflect.apply(target, receiver, args);
                    }
                    const timeoutMs = options.timeout;
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        const result = await callback(tx);
                        if (attempts === 1) {
                            await new Promise(resolve => setTimeout(resolve, timeoutMs + 20));
                            try { await tx.$queryRaw`SELECT 1::int AS value`; }
                            catch (error) { nativeFailure = error; throw error; }
                        }
                        return result;
                    }, ...args.slice(1)]);
                },
            });
            const result = inTx(async tx => {
                const attempt = ++attempts;
                afterTx(tx, () => { published.push(attempt); });
                return await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } }, select: { seq: true } });
            }, { maxWaitMs: 200, timeoutMs: 300, ...(callerDeadline ? { deadlineAtMs: Date.now() + 5_000 } : {}) });
            await expect(result).rejects.toBeInstanceOf(TransactionDeadlineExceededError);
            expect(nativeFailure).toMatchObject({ code: "P2028", meta: { error: expect.stringContaining("expired transaction") } });
            expect(attempts).toBe(1);
            expect(published).toEqual([]);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 0 });
        } finally {
            db.$transaction = transaction;
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("settles a real held-lock execution cancellation with zero replay and releases the connection", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const transaction = db.$transaction;
        let ready!: () => void;
        const locked = new Promise<void>(resolve => { ready = resolve; });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const holder = db.$transaction(async tx => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            ready();
            await released;
        });
        const holderOutcome = Promise.allSettled([holder]);
        let attempts = 0;
        const published = vi.fn();
        try {
            await Promise.race([locked, holder.then(() => { throw new Error("Holder exited before lock rendezvous"); })]);
            // A real operator statement limit wins deterministically over
            // Prisma's interactive timer. The owner must preserve this stricter
            // SQL limit and settle 57014 just as it settles native expiry.
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 100");
                        return callback(tx);
                    }, ...args.slice(1)]);
                },
            });
            const error: unknown = await inTx(async tx => {
                attempts++;
                afterTx(tx, published);
                await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            }, { maxWaitMs: 200, timeoutMs: 500, deadlineAtMs: Date.now() + 5_000 })
                .then(() => null, error => error);
            expect(error).toBeInstanceOf(TransactionDeadlineExceededError);
            if (!(error instanceof TransactionDeadlineExceededError)) throw error;
            expect(readPostgresTransactionSqlState(error.cause)).toBe("57014");
            expect(attempts).toBe(1);
            expect(published).not.toHaveBeenCalled();
        } finally { db.$transaction = transaction; release(); await holderOutcome; }
        try {
            expect(await inTx(tx => tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })))
                .toEqual({ seq: 1 });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it("retries a genuine serialization abort and delivers exactly the committed afterTx effect", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        let attempts = 0;
        let preparations = 0;
        let conflict: unknown;
        const published: number[] = [];
        try {
            const result = await inTx(async tx => {
                const attempt = ++attempts;
                afterTx(tx, () => { published.push(attempt); });
                await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                if (attempt === 1) await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                try {
                    return await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } }, select: { seq: true } });
                } catch (error) { conflict = error; throw error; }
            }, { isolationLevel: "Serializable", maxWaitMs: 1_000, timeoutMs: 3_000,
                prepare: async () => { preparations++; return async () => {}; } });
            expect(conflict).toMatchObject({ code: "P2034" });
            expect(attempts).toBe(2);
            expect(preparations).toBe(2);
            expect(published).toEqual([2]);
            expect(result).toEqual({ seq: 2 });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 2 });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });
});
