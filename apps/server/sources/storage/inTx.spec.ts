import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { installDbModuleMock, inTxPostgresControlStatementMock } from "../app/api/testkit/dbMocks";
import { withWebLatencyTrace } from "@/utils/webLatencyTrace";
import { initDbPostgres, prismaRuntime, shutdownDbClient } from "@/storage/prisma";
import type { Tx } from "./inTx";

// PostgreSQL command execution is the database boundary, including LOCAL settings.
const transactionBoundary = () => ({ ...inTxPostgresControlStatementMock });
const transaction = vi.fn(async (fn: any, _opts?: any) => fn(transactionBoundary()));
const delayMock = vi.fn(async () => {});
const recordDatabaseTransactionRetry = vi.fn();

installDbModuleMock({
    db: {
        $transaction: transaction,
    },
});

const logMock = vi.fn();

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));
vi.mock("@/utils/logging/log", () => ({
    log: (...args: any[]) => logMock(...args),
    logger: { isLevelEnabled: () => true },
}));
vi.mock("@/app/monitoring/metrics/sessionWriteMetrics", () => ({
    recordDatabaseTransactionRetry: (...args: any[]) => recordDatabaseTransactionRetry(...args),
}));

// `installDbModuleMock` uses `vi.doMock`, which is not hoisted, so `./inTx`
// has to load after the mocks above — but it must not load inside a case
// either. Paying the file's first transform inside a case's 20 s test budget
// is what made the first case time out under host load and leave its still
// running `inTx` to land an extra `$transaction` call in the next case. The
// module reads retry settings per call, while Prisma owns the initialized
// pool's lifetime, so one load here during collection serves every case.
const inTxModule = await import("./inTx");
const { inTx, afterTx, transactionResult } = inTxModule;

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnv(envSnapshot);
        transaction.mockReset();
        transaction.mockImplementation(async (fn: any, _opts?: any) => fn(transactionBoundary()));
        delayMock.mockClear();
        logMock.mockClear();
        recordDatabaseTransactionRetry.mockClear();
    });

    it("keeps transaction admission within the initialized pool budget until database reinitialization", async () => {
        applyEnvValues({
            HAPPIER_DB_PROVIDER: "postgres",
            DATABASE_URL: "postgresql://test:test@localhost:5432/test?connection_limit=3",
            HAPPIER_DB_CONNECTION_LIMIT: "2",
            HAPPY_DB_CONNECTION_LIMIT: undefined,
        });
        initDbPostgres();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const holder = inTx(async () => { entered(); await held; });
        try {
            await ready;
            // The native pool still has two slots. A later environment edit
            // must not let transactions consume its reserved discovery slot.
            process.env.HAPPIER_DB_CONNECTION_LIMIT = "5";
            await expect(inTx(async () => "unexpected admission", { maxWaitMs: 20 }))
                .rejects.toBeInstanceOf(inTxModule.TransactionAcquisitionUnavailableError);
        } finally {
            release();
            await holder;
            await shutdownDbClient();
        }

        process.env.HAPPIER_DB_CONNECTION_LIMIT = "3";
        initDbPostgres();
        let releaseReinitialized!: () => void;
        const heldReinitialized = new Promise<void>(resolve => { releaseReinitialized = resolve; });
        let reinitializedEntries = 0;
        const readers = [0, 1].map(() => inTx(async () => {
            reinitializedEntries++;
            await heldReinitialized;
        }));
        try {
            await vi.waitFor(() => expect(reinitializedEntries).toBe(2));
        } finally {
            releaseReinitialized();
            await Promise.all(readers);
            await shutdownDbClient();
        }
    });

    it("resolves an explicit transaction result once before commit and exposes it after commit", async () => {
        const phases: string[] = [];
        transaction.mockImplementationOnce(async fn => {
            const result = await fn(transactionBoundary());
            phases.push("commit");
            return result;
        });
        const project = vi.fn(() => {
            phases.push("project");
            return { cursor: 7 };
        });

        await expect(inTx(async tx => {
            afterTx(tx, () => { phases.push("after-commit"); });
            phases.push("domain");
            return transactionResult(project);
        })).resolves.toEqual({ cursor: 7 });

        expect(project).toHaveBeenCalledTimes(1);
        expect(phases).toEqual(["domain", "project", "commit", "after-commit"]);
    });

    it("rolls back a failing transaction result without running after-commit work", async () => {
        let committed = false;
        transaction.mockImplementationOnce(async fn => {
            const result = await fn(transactionBoundary());
            committed = true;
            return result;
        });
        const afterCommit = vi.fn();
        const failure = new Error("publication result unavailable");

        await expect(inTx(async tx => {
            afterTx(tx, afterCommit);
            return transactionResult(() => { throw failure; });
        })).rejects.toBe(failure);

        expect(committed).toBe(false);
        expect(afterCommit).not.toHaveBeenCalled();
    });

    it("preserves ordinary function and object transaction results", async () => {
        const ordinaryFunction = vi.fn(() => "caller-owned");
        const ordinaryObject = { resolve: ordinaryFunction };

        await expect(inTx(async () => ordinaryFunction)).resolves.toBe(ordinaryFunction);
        await expect(inTx(async () => ordinaryObject)).resolves.toBe(ordinaryObject);
        expect(ordinaryFunction).not.toHaveBeenCalled();
    });

    it("reports a failed after-commit callback instead of discarding it", async () => {
        const later = vi.fn();
        const failure = new Error("eviction publication failed");

        await expect(inTx(async (tx) => {
            afterTx(tx, () => { throw failure; });
            afterTx(tx, later);
            return "committed";
        })).resolves.toBe("committed");

        // The commit stands and later callbacks still run, but the failure is
        // observable rather than swallowed.
        expect(later).toHaveBeenCalledTimes(1);
        expect(logMock).toHaveBeenCalledWith(
            expect.objectContaining({ module: "storage-tx" }),
            expect.stringContaining("after-commit callback failed"),
            failure,
        );
    });

    it.each(["23b2ed82-2ef7-4e4e-af0f-f64d599a08c6", "req-142h"])("attributes transaction timings to their owner without losing request correlation (%s)", async (requestId) => {
        applyEnvValues({ HAPPIER_WEB_LATENCY_TRACE: "1", HAPPIER_DB_PROVIDER: "postgres" });
        await expect(withWebLatencyTrace(requestId, () => inTx(async (tx) => {
            expect(inTxModule.getTransactionContext(tx, { optional: true })?.requestId).toBe(requestId);
            return "committed";
        }, {
            transactionClass: "qualified-provider-account-usage.write",
        }))).resolves.toBe("committed");

        for (const phase of ["db.transaction.callback", "db.transaction.attempt"]) {
            expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
                phase, requestId, transactionClass: "qualified-provider-account-usage.write",
                elapsedMs: expect.any(Number),
            }), "[web-latency]");
        }
    });

    it("carries the transaction owner on a request-deadline error", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres" });
        vi.spyOn(Date, "now").mockReturnValue(1_000);

        await expect(inTx(async () => "unreachable", {
            deadlineAtMs: 1_000,
            transactionClass: "workflow-pull-run-origin-delivery",
        })).rejects.toMatchObject({
            name: "TransactionDeadlineExceededError",
            transactionClass: "workflow-pull-run-origin-delivery",
        });
        expect(transaction).not.toHaveBeenCalled();
    });

    it.each([
        { code: "P2028", message: "A query cannot be executed on an expired transaction.", isolationLevel: "RepeatableRead", readOnly: true, outcome: "deadline-exceeded" },
        { code: "P2034", message: "Transaction failed due to a write conflict or a deadlock.", isolationLevel: "Serializable", readOnly: false, outcome: "conflict-exhausted" },
    ] as const)("distinguishes $code rollback diagnostics at the actual isolation policy", async failure => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "0" });
        await expect(inTx(async () => { throw new PrismaClientKnownRequestError(failure.message, {
            code: failure.code, clientVersion: "6.19.2",
        }); }, { isolationLevel: failure.isolationLevel, readOnly: failure.readOnly, transactionClass: "measured-owner" }))
            .rejects.toBeInstanceOf(failure.code === "P2028" ? inTxModule.TransactionDeadlineExceededError : inTxModule.TransactionConflictExhaustedError);
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ event: "transaction-rollback", prismaCode: failure.code,
            isolationLevel: failure.isolationLevel, readOnly: failure.readOnly, transactionClass: "measured-owner", attempts: 1, outcome: failure.outcome }),
        failure.code === "P2028" ? "Database transaction deadline expired" : "Database transaction rollback recovery exhausted");
    });

    it("uses read-committed transactions by default", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const result = await inTx(async () => 123);

        expect(result).toBe(123);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(expect.objectContaining({ isolationLevel: "ReadCommitted" }));
    });

    it.each([0, 60])("changes the SQL budget only when the remaining budget crosses the existing timeout (callback work: %s ms)", async callbackWorkMs => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres" });
        let clock = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        const budgets: number[] = [];
        let appliedBudget = 50;
        let queryBudget: number | undefined;
        transaction.mockImplementation(async fn => fn({
            ...transactionBoundary(),
            async $queryRaw() { clock += 2; return [{ statement_timeout: "50ms" }]; },
            async $executeRawUnsafe(query: string) {
                appliedBudget = Number(query.split(" = ")[1]);
                budgets.push(appliedBudget);
                clock += 2;
                return 0;
            },
            $queryRawUnsafe() {
                // The persistent Prisma boundary is lazy: no SQL before await.
                return { then(resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve().then(() => { queryBudget = appliedBudget; return [{ value: 1 }]; }).then(resolve, reject);
                } };
            },
        }));
        await expect(inTx(async tx => {
            // Before callback SQL, no eager timeout-setting round trip is needed.
            expect(budgets).toEqual([]);
            clock += callbackWorkMs;
            return await tx.$queryRawUnsafe("SELECT 1 AS value");
        }, { timeoutMs: 100, readOnly: true })).resolves.toEqual([{ value: 1 }]);
        const expectedBudget = Math.min(50, 98 - callbackWorkMs);
        expect(budgets).toEqual(expectedBudget === 50 ? [] : [expectedBudget]);
        expect(queryBudget).toBe(expectedBudget);
    });

    it("refuses an attempt that expires during budget discovery before invoking its callback", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "0" });
        let clock = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        transaction.mockImplementation(async fn => fn({
            ...transactionBoundary(),
            async $queryRaw() { clock += 100; return [{ statement_timeout: "0" }]; },
        }));
        const callback = vi.fn(async () => "must not run");
        await expect(inTx(callback, { timeoutMs: 100 }))
            .rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(callback).not.toHaveBeenCalled();
    });

    it.each([false, true])("orders an optional prepared fence before the first callback read (prepare: %s)", async prepared => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres" });
        vi.spyOn(Date, "now").mockReturnValue(1_000);
        const statements: string[] = [];
        transaction.mockImplementation(async fn => {
            statements.push("begin");
            return fn({
                ...transactionBoundary(),
                async $queryRaw(query: TemplateStringsArray) {
                    statements.push(query.join("?"));
                    return [{ statement_timeout: "0" }];
                },
                async $executeRawUnsafe(query: string) { statements.push(query); return 0; },
                $queryRawUnsafe(query: string) {
                    return { then(resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
                        return Promise.resolve().then(() => { statements.push(query); return []; }).then(resolve, reject);
                    } };
                },
            });
        });
        await expect(inTx(async tx => {
            await tx.$queryRawUnsafe("callback read");
            return "committed";
        }, {
            isolationLevel: "Serializable", timeoutMs: 1234, maxWaitMs: 234,
            ...(prepared ? { prepare: async () => {
                statements.push("prepare");
                return async (tx: Tx) => { await tx.$queryRawUnsafe("fence"); };
            } } : {}),
        })).resolves.toBe("committed");
        expect(statements).toEqual([
            ...(prepared ? ["prepare"] : []), "begin", "SHOW statement_timeout",
            "SET LOCAL statement_timeout = 1234", ...(prepared ? ["fence"] : []), "callback read",
        ]);
        expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: "Serializable", timeout: 1234, maxWait: 234 });
    });

    it("prepares a fresh fence on replay before admitting the callback", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const admitted: number[] = [];
        const fenced: number[] = [];
        let preparations = 0;
        await expect(inTx(async () => {
            admitted.push(preparations);
            return "committed";
        }, { prepare: async () => {
            const attempt = ++preparations;
            return async () => {
                fenced.push(attempt);
                if (attempt === 1) throw new inTxModule.TransactionReplayRequiredError("session-account-audience-changed");
            };
        } })).resolves.toBe("committed");
        expect(fenced).toEqual([1, 2]);
        expect(admitted).toEqual([2]);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("charges preparation time to the original request deadline", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        const callback = vi.fn(async () => "unreachable");
        const fence = vi.fn(async () => {});
        await expect(inTx(callback, { deadlineAtMs: 2_000, prepare: async () => {
            now.mockReturnValue(2_000);
            return fence;
        } })).rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(transaction).not.toHaveBeenCalled();
        expect(fence).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    it("charges preparation to the derived maxWait plus timeout deadline without a caller deadline", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        const callback = vi.fn(async () => "unreachable");
        await expect(inTx(callback, { maxWaitMs: 100, timeoutMs: 100, prepare: async () => {
            now.mockReturnValue(1_200);
            return async () => {};
        } })).rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(transaction).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    it("refuses conflict backoff beyond the derived operation deadline", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "200",
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        const conflict = Object.assign(new Error("Rolled back"), { code: "P2034" });
        transaction.mockImplementationOnce(async () => { now.mockReturnValue(1_100); throw conflict; });
        await expect(inTx(async () => "must not replay", { maxWaitMs: 100, timeoutMs: 100 }))
            .rejects.toMatchObject({ name: "TransactionConflictExhaustedError", cause: conflict });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each([undefined, 10_000])("settles its expired PostgreSQL attempt without replaying queued SQL (deadline: %s)", async deadlineAtMs => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        let attempts = 0;
        const writes: number[] = [], published: number[] = [];
        transaction.mockImplementation(async fn => fn({
            ...transactionBoundary(),
            $queryRawUnsafe(query: string) {
                // Prisma queries are lazy: time elapses when the SQL boundary
                // is awaited, after the owner's pre-statement budget refresh.
                return { then(resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve().then(() => {
                        if (query === "slow admission read" && attempts === 1) now.mockReturnValue(2_001);
                        if (query === "admission write") writes.push(attempts);
                        return [];
                    }).then(resolve, reject);
                } };
            },
        }));
        await expect(inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            await Promise.all([
                tx.$queryRawUnsafe("slow admission read"),
                tx.$queryRawUnsafe("admission write"),
            ]);
            return "committed";
        }, { timeoutMs: 1_000, ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) }))
            .rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(attempts).toBe(1);
        expect(writes).toEqual([]);
        expect(published).toEqual([]);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it("does not replay its expired PostgreSQL attempt beyond the original request deadline", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        const published = vi.fn();
        transaction.mockImplementation(async fn => fn({
            ...transactionBoundary(), $queryRawUnsafe() {
                return { then(resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve().then(() => { now.mockReturnValue(2_001); return []; }).then(resolve, reject);
                } };
            },
        }));
        await expect(inTx(async tx => {
            afterTx(tx, published);
            await tx.$queryRawUnsafe("slow admission read");
            await tx.$queryRawUnsafe("never execute");
        }, { timeoutMs: 1_000, deadlineAtMs: 2_000 })).rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(published).not.toHaveBeenCalled();
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each([false, true])("preserves rollback certainty when its PostgreSQL attempt recovery exhausts (earlier unknown: %s)", async earlierUnknown => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: earlierUnknown ? "1" : "0" });
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        const uncertainCompletion = new Error("Connection lost while handling serialization failure");
        const published = vi.fn();
        if (earlierUnknown) transaction.mockRejectedValueOnce(uncertainCompletion);
        transaction.mockImplementation(async fn => fn({
            ...transactionBoundary(), $queryRawUnsafe() {
                return { then(resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve().then(() => { now.mockReturnValue(2_001); return []; }).then(resolve, reject);
                } };
            },
        }));
        const result = inTx(async tx => {
            afterTx(tx, published);
            await tx.$queryRawUnsafe("slow admission read");
            await tx.$queryRawUnsafe("never execute");
        }, { timeoutMs: 1_000 });
        if (earlierUnknown) await expect(result).rejects.toBe(uncertainCompletion);
        else await expect(result).rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(published).not.toHaveBeenCalled();
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it.each(["postgres", "sqlite"])("does not begin preparation after an expired deadline on %s", async provider => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: provider });
        vi.spyOn(Date, "now").mockReturnValue(2_000);
        const prepare = vi.fn(async () => async () => {});
        await expect(inTx(async () => "unreachable", {
            deadlineAtMs: 2_000, prepare,
        })).rejects.toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(prepare).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
    });

    it("passes configured transaction timeout options without isolationLevel on SQLite", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TIMEOUT_MS: "12000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "7000",
        });

        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: 7000,
                timeout: 12000,
            }),
        );
        expect(transaction.mock.calls[0]![1]).not.toEqual(
            expect.objectContaining({ isolationLevel: expect.anything() }),
        );
    });

    it("preserves explicit serializable isolation for cross-row invariants", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const result = await inTx(async () => 321, { isolationLevel: "Serializable" });

        expect(result).toBe(321);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({ isolationLevel: "Serializable" }),
        );
    });

    it("caps transaction acquisition and execution inside an absolute request deadline", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
        });
        vi.spyOn(Date, "now").mockReturnValue(1_000);

        await expect(inTx(async () => 123, { deadlineAtMs: 10_000 })).resolves.toBe(123);

        expect(transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
            maxWait: expect.any(Number),
            timeout: expect.any(Number),
        }));
        const options = transaction.mock.calls[0]![1] as { maxWait: number; timeout: number };
        expect(options.maxWait + options.timeout).toBeLessThanOrEqual(9_000);
    });

    it("retries P2034 and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn(transactionBoundary()));

        const result = await inTx(async () => 789);

        expect(result).toBe(789);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("postgres");
    });

    it.each([
        new PrismaClientKnownRequestError(
            'Raw query failed. Code: `40001`. Message: `could not serialize access due to read/write dependencies among transactions`',
            { code: "P2010", clientVersion: "6.19.2", meta: { code: "40001", message: "could not serialize access due to read/write dependencies among transactions" } },
        ),
        new prismaRuntime.PrismaClientUnknownRequestError(
            'Invalid `prisma.session.update()` invocation: PostgresError { code: "40P01", message: "deadlock detected" }',
            { clientVersion: "6.19.2" },
        ),
        ...["40001", "40P01"].map(code => new PrismaClientKnownRequestError(
            `Raw query failed. Code: \`${code}\`. Message: \`transaction conflict\``,
            { code: "P2010", clientVersion: "6.19.2", meta: { code, message: "transaction conflict" } },
        )),
    ])("replays PostgreSQL conflicts without publishing rolled-back afterTx effects: %s", async (failure) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        let attempts = 0;
        const published: number[] = [];

        await expect(inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            if (attempt === 1) throw failure;
            return "committed";
        })).resolves.toBe("committed");

        expect(attempts).toBe(2);
        expect(published).toEqual([2]);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("preserves the retry budget and exposes one typed PostgreSQL conflict after exhaustion", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const failure = new PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010", clientVersion: "6.19.2", meta: { code: "40001" },
        });
        let attempts = 0;
        const published = vi.fn();
        await expect(inTx(async tx => {
            attempts++;
            afterTx(tx, published);
            throw failure;
        })).rejects.toMatchObject({
            name: "TransactionConflictExhaustedError",
            code: "database_transaction_conflict_exhausted",
            cause: failure,
        });
        expect(attempts).toBe(2);
        expect(published).not.toHaveBeenCalled();
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("replays audience acquisition under the existing retry budget (exhausted: %s)", async (exhausted) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        let attempts = 0;
        const published: number[] = [];
        const operation = inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            if (exhausted || attempt === 1) throw new inTxModule.TransactionReplayRequiredError("session-account-audience-changed");
            return "committed";
        });

        if (exhausted) {
            await expect(operation).rejects.toMatchObject({
                name: "TransactionConflictExhaustedError", code: "database_transaction_conflict_exhausted",
            });
            expect(published).toEqual([]);
        } else {
            await expect(operation).resolves.toBe("committed");
            expect(published).toEqual([2]);
        }
        expect(attempts).toBe(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        { meta: { code: "40001", modelName: "Session", message: "ERROR: could not serialize access due to read/write dependencies among transactions\nDETAIL: private query contents" },
            failedStatementRelation: "Session", driverMessage: "could not serialize access due to read/write dependencies among transactions" },
        { meta: { code: "40001", message: "ERROR: could not serialize access due to concurrent update" },
            failedStatementRelation: undefined, driverMessage: "could not serialize access due to concurrent update" },
        { meta: { code: "40001", message: "private query contents" }, failedStatementRelation: undefined, driverMessage: undefined },
    ])("reports rollback transaction class and content-free last driver diagnostics (%j)", async ({ meta, failedStatementRelation, driverMessage }) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const failure = new PrismaClientKnownRequestError("private query contents", {
            code: "P2010", clientVersion: "6.19.2", meta,
        });
        let attempts = 0;
        await expect(inTx(async () => {
            if (++attempts === 1) throw new PrismaClientKnownRequestError("earlier deadlock", {
                code: "P2010", clientVersion: "6.19.2", meta: { code: "40P01", message: "deadlock detected" },
            });
            throw failure;
        }, { transactionClass: "pending-input-admission" }))
            .rejects.toMatchObject({ code: "database_transaction_conflict_exhausted" });
        const diagnostic = logMock.mock.calls.find(([context]) => context.module === "storage-tx" && context.event === "transaction-rollback");
        expect(diagnostic).toBeDefined();
        expect(diagnostic![0]).toMatchObject({
            transactionClass: "pending-input-admission", provider: "postgres", sqlState: "40001", outcome: "conflict-exhausted", attempts: 2,
        });
        expect(diagnostic![0].failedStatementRelation).toBe(failedStatementRelation);
        expect(diagnostic![0].driverErrorCode).toBe("40001");
        expect(diagnostic![0].driverErrorMessage).toBe(driverMessage);
        expect(diagnostic![0].conflictingRelation).toBeUndefined();
        expect(JSON.stringify(diagnostic)).not.toContain("private query contents");
    });

    it.each([
        { kind: "acquisition-unavailable", message: "Unable to start a transaction in the given time. private query contents" },
        { kind: "expired-timeout", message: "Transaction already closed: A query cannot be executed on an expired transaction. private query contents" },
        { kind: "transaction-not-found", message: "Transaction not found. private query contents" },
    ])("distinguishes content-free P2028 subtype $kind at exhaustion", async ({ kind, message }) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const failure = new prismaRuntime.PrismaClientKnownRequestError("private wrapper contents", {
            code: "P2028", clientVersion: "6.19.2", meta: { error: message },
        });
        if (kind === "acquisition-unavailable") transaction.mockRejectedValue(failure);
        await expect(inTx(async () => { throw failure; }, { transactionClass: "teams.restore" }))
            .rejects.toMatchObject({ cause: failure });
        const diagnostic = logMock.mock.calls.find(([context]) => context.module === "storage-tx" && context.prismaCode === "P2028");
        expect(diagnostic?.[0]).toMatchObject({
            transactionClass: "teams.restore", prismaTransactionErrorKind: kind, attempts: 1,
            outcome: kind === "acquisition-unavailable" ? "acquisition-unavailable" : kind === "expired-timeout" ? "deadline-exceeded" : "conflict-exhausted",
        });
        expect(JSON.stringify(logMock.mock.calls)).not.toContain("private");
    });

    it.each([
        { provider: "postgres", code: "42601" },
        { provider: "mysql", code: "40001" },
        { provider: "sqlite", code: "40P01" },
    ])("does not retry unrelated raw-query failures on $provider ($code)", async ({ provider, code }) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: provider });
        const failure = new PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010", clientVersion: "6.19.2", meta: { code },
        });
        const published = vi.fn();
        await expect(inTx(async tx => {
            afterTx(tx, published);
            throw failure;
        })).rejects.toBe(failure);
        expect(published).not.toHaveBeenCalled();
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each([
        "A query cannot be executed on an expired transaction.",
        "A batch query cannot be executed on an expired transaction.",
        "A commit cannot be executed on an expired transaction.",
    ])("settles a transaction that Prisma expired whichever operation found it (%s)", async operation => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const expired = new PrismaClientKnownRequestError("Expired", {
            code: "P2028", clientVersion: "6.19.2",
            meta: { error: `Transaction already closed: ${operation} The timeout for this transaction was 15000 ms, however 31000 ms passed since the start of the transaction.` },
        });
        let attempts = 0;
        const published: number[] = [];
        await expect(inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            if (attempt === 1) throw expired;
            return "committed";
        })).rejects.toMatchObject({ name: "TransactionDeadlineExceededError", code: "database_transaction_timeout", cause: expired });
        expect(attempts).toBe(1);
        expect(published).toEqual([]);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each([
        { sqlState: "57014", message: undefined, timeout: false },
        { sqlState: "57014", message: "canceling statement due to user request", timeout: false },
        { sqlState: "57014", message: "canceling statement due to statement timeout", timeout: true },
        { sqlState: "55P03", message: undefined, timeout: false },
        { sqlState: "55P03", message: "could not obtain lock on row in relation private_relation", timeout: false },
        { sqlState: "55P03", message: "canceling statement due to lock timeout", timeout: true },
    ])("settles PostgreSQL $sqlState ($message) without generic in-place replay", async ({ sqlState, message, timeout }) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const cancelled = new PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010", clientVersion: "6.19.2", meta: { code: sqlState, ...(message ? { message } : {}) },
        });
        let attempts = 0;
        const published: number[] = [];
        await expect(inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            if (attempt === 1) throw cancelled;
            return "committed";
        })).rejects.toMatchObject({
            name: timeout ? "TransactionDeadlineExceededError" : "TransactionConflictExhaustedError",
            code: timeout ? "database_transaction_timeout" : "database_transaction_conflict_exhausted",
            cause: cancelled,
        });
        expect(attempts).toBe(1);
        expect(published).toEqual([]);
        expect(delayMock).not.toHaveBeenCalled();
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ event: "transaction-rollback", sqlState }),
            timeout ? "Database transaction deadline expired" : "Database transaction rollback recovery exhausted");
    });

    it("retries repeated postgres P2034 conflicts until a later attempt succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me 1"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 2"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 3"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 4"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 5"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 6"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 7"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 8"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn(transactionBoundary()));

        const result = await inTx(async () => 1337);

        expect(result).toBe(1337);
        expect(transaction).toHaveBeenCalledTimes(9);
        expect(delayMock).toHaveBeenCalledTimes(8);
        expect(delayMock.mock.calls).toEqual([[200], [400], [800], [1600], [3200], [5000], [5000], [5000]]);
    });

    it.each(["postgres", "mysql", "sqlite"].flatMap(provider => ["P2028", "P2024"].map(code => ({ provider, code }))))("preserves the $provider acquisition policy for $code before callback entry", async ({ provider, code }) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code, meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction
            .mockRejectedValueOnce(acquisitionError)
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn(transactionBoundary()));
        const transactionBody = vi.fn(async () => 790);

        if (provider === "postgres") {
            await expect(inTx(transactionBody)).rejects.toMatchObject({ name: "TransactionAcquisitionUnavailableError", cause: acquisitionError });
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(transactionBody).not.toHaveBeenCalled();
            expect(delayMock).not.toHaveBeenCalled();
        } else {
            await expect(inTx(transactionBody)).resolves.toBe(790);
            expect(transaction).toHaveBeenCalledTimes(2);
            expect(transactionBody).toHaveBeenCalledTimes(1);
            expect(delayMock).toHaveBeenCalledTimes(1);
        }
    });

    it.each(["P2028", "P2024"])("reports exhausted transaction acquisition %s as typed unavailability with the original cause", async (code) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_DB_TX_MAX_RETRIES: "0",
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code, meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction.mockRejectedValue(acquisitionError);
        const transactionBody = vi.fn(async () => 791);

        const rejection = await inTxModule.inTx(transactionBody).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(inTxModule.TransactionAcquisitionUnavailableError);
        expect(rejection).toMatchObject({ code: "P2028", cause: acquisitionError });
        expect(transactionBody).not.toHaveBeenCalled();
    });

    it.each(["P2028", "P2024"])("does not classify %s thrown after the callback starts as transaction acquisition", async (code) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
        });
        const operationError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code, meta: { error: "Unable to start a transaction in the given time." } },
        );
        const transactionBody = vi.fn(async () => {
            throw operationError;
        });

        await expect(inTx(transactionBody)).rejects.toBe(operationError);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each(["postgres", "mysql", "sqlite"])("reports an explicitly expired Prisma transaction as timeout after recovery on %s", async (provider) => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: provider, HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const failure = new PrismaClientKnownRequestError("Expired query", {
            code: "P2028", clientVersion: "6.19.2",
            meta: { error: "Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15048 ms passed since the start of the transaction." },
        });
        const body = vi.fn(async () => { throw failure; });
        const result = await inTx(body).catch((error: unknown) => error);
        expect(result).toBeInstanceOf(inTxModule.TransactionDeadlineExceededError);
        expect(result).toMatchObject({ code: "database_transaction_timeout", cause: failure });
        expect(body).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each(["Transaction already closed", "A query cannot be executed on a committed transaction."])("does not infer rollback from an unclassified P2028 (%s)", async (message) => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "postgres" });
        const failure = Object.assign(new Error(message), { code: "P2028" });
        await expect(inTx(async () => { throw failure; })).rejects.toBe(failure);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it.each([false, true])("settles missing native transactions according to callback completion (completed: %s)", async completed => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const failure = new prismaRuntime.PrismaClientKnownRequestError("Transaction API error", {
            code: "P2028", clientVersion: "6.19.2",
            meta: { error: "Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting." },
        });
        const published: number[] = [];
        let attempts = 0;
        transaction.mockImplementation(async fn => {
            attempts += 1;
            if (completed) {
                await fn({ ...transactionBoundary(), $queryRawUnsafe: async () => [] });
                throw failure;
            }
            return fn({ ...transactionBoundary(),
                $queryRawUnsafe: async () => { if (attempts === 1) throw failure; return []; },
            });
        });
        const result = inTx(async tx => {
            afterTx(tx, () => { published.push(attempts); });
            await tx.$queryRawUnsafe("callback read");
            return "committed";
        });
        if (completed) {
            await expect(result).rejects.toBe(failure);
            expect(attempts).toBe(1);
            expect(published).toEqual([]);
        } else {
            await expect(result).rejects.toMatchObject({ name: "TransactionConflictExhaustedError", cause: failure });
            expect(attempts).toBe(1);
            expect(published).toEqual([]);
        }
    });

    it("does not replay an unstructured PostgreSQL message that cannot prove a concurrency abort", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        const failure = new Error("could not serialize access due to read/write dependencies among transactions");
        transaction
            .mockRejectedValueOnce(failure)
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn(transactionBoundary()));

        await expect(inTx(async () => 4242)).rejects.toBe(failure);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
        expect(recordDatabaseTransactionRetry).not.toHaveBeenCalled();
    });

    it("retries sqlite P1008 socket timeout and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Socket timeout"), { code: "P1008" }))
            .mockImplementationOnce(async (fn: any) => fn(transactionBoundary()));

        const result = await inTx(async () => 9001);

        expect(result).toBe(9001);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("retries sqlite P2024 connection pool timeouts and preserves retry metrics", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }))
            .mockImplementationOnce(async (fn: any) => fn(transactionBoundary()));

        const result = await inTx(async () => 9002);

        expect(result).toBe(9002);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("sqlite");
    });

    it.each([
        { code: "P2034", message: "Transaction rolled back after a write conflict" },
        { code: "P2028", message: "Unable to start a transaction in the given time." },
        { code: "P2024", message: "Timed out fetching a new connection from the connection pool." },
        { code: "P2028", message: "A query cannot be executed on an expired transaction." },
    ])("does not claim definite no-effect after an earlier ambiguous SQLite attempt ($code)", async ({ code, message }) => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "sqlite", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const uncertainCompletion = Object.assign(new Error("SQLite completion socket timeout"), { code: "P1008" });
        // The first callback actually ran; its driver then loses the completion
        // result. A later rollback/acquisition failure cannot erase that fact.
        transaction
            .mockImplementationOnce(async fn => { await fn(transactionBoundary()); throw uncertainCompletion; })
            .mockRejectedValueOnce(Object.assign(new Error(message), { code }));

        await expect(inTx(async () => "request-effect")).rejects.toBe(uncertainCompletion);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("does not start a sqlite retry that would exceed the configured total retry budget", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "1",
            HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "100",
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
        });
        const timeoutError = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        transaction
            .mockRejectedValueOnce(timeoutError)
            .mockImplementationOnce(async (fn: any) => fn(transactionBoundary()));


        // A socket timeout is retryable by the existing SQLite owner but does
        // not establish rollback. Preserve its cause rather than claiming a
        // certain conflict refusal when the recovery budget is exhausted.
        await expect(inTx(async () => 9003)).rejects.toBe(timeoutError);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
        expect(recordDatabaseTransactionRetry).not.toHaveBeenCalled();
    });

    it.each([false, true])("retains the typed SQLite deadline and earlier ambiguous cause (callback entered: %s)", async (callbackEntered) => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "sqlite", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const uncertainCompletion = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        const finalFailure = Object.assign(new Error(callbackEntered ? "Transaction is already closed" : "Unable to start a transaction"), { code: "P2028" });
        transaction.mockRejectedValueOnce(uncertainCompletion);
        if (callbackEntered) {
            transaction.mockImplementationOnce(async fn => { await fn(transactionBoundary()); throw finalFailure; });
        } else {
            transaction.mockRejectedValueOnce(finalFailure);
        }

        await expect(inTx(async () => "request-effect", { deadlineAtMs: Date.now() + 60_000 })).rejects.toMatchObject({
            name: "TransactionDeadlineExceededError", cause: uncertainCompletion,
        });
    });

    it("preserves confirmed SQL rollback even when the caller supplied a longer deadline", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres" });
        const failure = new PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010", clientVersion: "6.19.2", meta: { code: "57014" },
        });
        await expect(inTx(async () => { throw failure; }, { deadlineAtMs: Date.now() + 60_000 }))
            .rejects.toMatchObject({ name: "TransactionConflictExhaustedError", cause: failure });
        expect(delayMock).not.toHaveBeenCalled();
    });
});
