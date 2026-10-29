import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { afterTx, inTx, TransactionDeadlineExceededError, type Tx } from "@/storage/inTx";
import { logger } from "@/utils/logging/log";
import { withWebLatencyTrace } from "@/utils/webLatencyTrace";
import * as latencyTrace from "@/utils/webLatencyTrace";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL managed attempt phase capture", () => {
    const originalLevel = logger.level;
    let connected = false;
    let records: Record<string, unknown>[];

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "1");
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    beforeEach(() => {
        records = [];
        vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "1");
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        logger.level = "trace";
        // Pino is the external logging boundary; transaction and SQL logic stay real.
        for (const level of ["trace", "debug"] as const) vi.spyOn(logger, level).mockImplementation((record: unknown) => {
            if (record && typeof record === "object") records.push(record as Record<string, unknown>);
        });
    });
    afterEach(() => { vi.restoreAllMocks(); logger.level = originalLevel; });
    afterAll(async () => { if (connected) await db.$disconnect(); vi.unstubAllEnvs(); });

    it.each(["commit", "expiry", "disabled"] as const)("captures exactly one settled attempt for %s and joins SQL without content", async shape => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        records.length = 0;
        const requestId = randomUUID();
        const published: number[] = [];
        const transaction = db.$transaction;
        if (shape === "disabled") vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "0");
        if (shape === "expiry") {
            // Fault only at the native DB boundary, as in inTx.expired: finish
            // actual SQL, then let Prisma's timer roll back before native commit.
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    const options = args[1];
                    if (typeof callback !== "function" || !options || typeof options !== "object"
                        || !("timeout" in options) || typeof options.timeout !== "number") return Reflect.apply(target, receiver, args);
                    const timeout = options.timeout;
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        const result = await callback(tx);
                        await new Promise(resolve => setTimeout(resolve, timeout + 20));
                        return result;
                    }, ...args.slice(1)]);
                },
            });
        }
        const clock = vi.spyOn(performance, "now");
        // Observe real trace-state allocations without replacing internal logic.
        const allocations = vi.spyOn(latencyTrace, "createWebLatencyTransactionAttempt");
        try {
            const outcome = await withWebLatencyTrace(requestId, () => inTx(async tx => {
                const row = await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } }, select: { seq: true } });
                afterTx(tx, () => { published.push(row.seq); });
                return row;
            }, { transactionClass: "provider-catalog-write", timeoutMs: 400, maxWaitMs: 1_000 }))
                .then(value => ({ value }), error => ({ error }));
            if (shape === "disabled") {
                expect(clock).not.toHaveBeenCalled();
                expect(allocations).not.toHaveBeenCalled();
            }
            const attempts = records.filter(record => record.phase === "db.transaction.phases");
            if (shape === "expiry") {
                expect(outcome).toMatchObject({ error: expect.any(TransactionDeadlineExceededError) });
                expect(published).toEqual([]);
            } else {
                expect(outcome).toEqual({ value: { seq: 1 } });
                expect(published).toEqual([1]);
            }
            // Pair the quiet-path cost assertion with committed state reaching
            // the actual afterTx consumer, and a rolled-back native expiry.
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(shape === "expiry" ? 0 : 1);
            if (shape === "disabled") {
                expect(records).toEqual([]);
                return;
            }
            expect(attempts).toHaveLength(1);
            const capture = attempts[0];
            expect(capture).toMatchObject({ requestId, attemptId: expect.any(Number), transactionClass: "provider-catalog-write",
                provider: "postgres", isolationLevel: "ReadCommitted", entryAtMs: expect.any(Number), deadlineAtMs: expect.any(Number),
                admissionSubmittedAtMs: expect.any(Number), admissionAcquiredAtMs: expect.any(Number),
                nativeCallbackStartedAtMs: expect.any(Number), nativeCallbackEndedAtMs: expect.any(Number),
                publicationCompletedAtMs: expect.any(Number), settledAtMs: expect.any(Number),
                settlement: shape === "expiry" ? "rolled-back" : "committed" });
            expect(capture.deadlineAtMs).toBe(Number(capture.entryAtMs) + 1_400);
            const phases = [capture.entryAtMs, capture.admissionSubmittedAtMs, capture.admissionAcquiredAtMs,
                capture.nativeCallbackStartedAtMs, capture.publicationCompletedAtMs, capture.nativeCallbackEndedAtMs, capture.settledAtMs].map(Number);
            expect(phases).toEqual([...phases].sort((a, b) => a - b));
            const sql = records.filter(record => record.requestId === requestId && typeof record.phase === "string"
                && record.phase.startsWith("db.") && !record.phase.startsWith("db.transaction."));
            expect(sql.length).toBeGreaterThan(0);
            expect(sql.every(record => record.attemptId === capture.attemptId)).toBe(true);
            if (shape === "expiry") expect(capture).toMatchObject({ code: "P2028", discoveryPoint: "commit",
                nativeTimeoutMs: expect.any(Number), nativeElapsedMs: expect.any(Number) });
            expect(JSON.stringify(records)).not.toContain(account.id);
            expect(JSON.stringify(records)).not.toContain("SELECT");
            expect(JSON.stringify(records)).not.toContain("Transaction API error");
        } finally {
            db.$transaction = transaction;
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("keeps rollback SQL and the committed retry on distinct attempts of the same request", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const requestId = randomUUID();
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "1");
        let attempts = 0;
        const published: number[] = [];
        try {
            await withWebLatencyTrace(requestId, () => inTx(async tx => {
                const attempt = ++attempts;
                afterTx(tx, () => { published.push(attempt); });
                await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                if (attempt === 1) await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`;
            }, { transactionClass: "provider-catalog-write" }));
            const captures = records.filter(record => record.phase === "db.transaction.phases" && record.requestId === requestId);
            expect(captures).toHaveLength(2);
            expect(captures[0]).toMatchObject({ settlement: "rolled-back", sqlState: "40001", failedSqlPhase: "db.raw.$executeRaw" });
            expect(captures[1]).toMatchObject({ settlement: "committed" });
            expect(captures[0].attemptId).not.toBe(captures[1].attemptId);
            expect(published).toEqual([2]);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
            const sqlAttempts = records.filter(record => record.requestId === requestId && record.phase === "db.Account.update")
                .map(record => record.attemptId);
            expect(sqlAttempts).toEqual(captures.map(record => record.attemptId));
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });
});
