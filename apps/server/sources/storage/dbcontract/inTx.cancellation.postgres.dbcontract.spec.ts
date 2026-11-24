import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";
import { logger } from "@/utils/logging/log";
import { withWebLatencyTrace } from "@/utils/webLatencyTrace";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL transaction cancellation", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    it.each(["deadline", "abort"] as const)("settles, rolls back and frees the connection on %s while the callback is pending", async (boundary) => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const requestId = randomUUID();
        const controller = new AbortController();
        const warn = vi.spyOn(logger, "warn");
        let releaseCallback!: () => void;
        let reportWrite!: (pid: number) => void;
        const pending = new Promise<void>(resolve => { releaseCallback = resolve; });
        const written = new Promise<number>(resolve => { reportWrite = resolve; });
        const onCommit = vi.fn();
        const outcome = withWebLatencyTrace(requestId, () => inTx(async tx => {
            afterTx(tx, onCommit);
            const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            reportWrite(backend.pid);
            await pending;
        }, { deadlineAtMs: Date.now() + (boundary === "abort" ? 10_000 : 1_200), signal: controller.signal }))
            .then(value => ({ value }), error => ({ error }));
        try {
            const pid = await Promise.race([written, outcome.then(result => { throw new Error("Transaction failed before the write", { cause: result }); })]);
            if (boundary === "abort") controller.abort();
            await expect.poll(async () => {
                const [record] = await db.$queryRaw<Array<{ open: number }>>`
                    SELECT count(*)::int AS open FROM pg_stat_activity
                    WHERE pid = ${pid} AND (xact_start IS NOT NULL AND pid <> pg_backend_pid())`;
                return record.open;
            }, { timeout: 2_500 }).toBe(0);
            await expect.poll(() => Promise.race([outcome, Promise.resolve("pending")]), { timeout: 500 })
                .toMatchObject({ error: { name: boundary === "deadline" ? "TransactionDeadlineExceededError" : "AbortError" } });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 0 });
            expect(onCommit).not.toHaveBeenCalled();
            const warnings = warn.mock.calls.filter(([record]) => typeof record === "object" && record !== null
                && "requestId" in record && record.requestId === requestId);
            if (boundary === "deadline") {
                expect(warnings).toEqual([[expect.objectContaining({
                    module: "storage-tx", outcome: "deadline-exceeded",
                    callSite: expect.stringMatching(/inTx\.cancellation\.postgres\.dbcontract\.spec\.ts:\d+/),
                }), "Database transaction deadline expired"]]);
            }
        } finally {
            releaseCallback();
            await outcome;
            warn.mockRestore();
            await db.account.delete({ where: { id: account.id } });
        }
    }, 15_000);
});
