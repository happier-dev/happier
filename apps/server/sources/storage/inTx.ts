import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { warn } from "@/utils/logging/log";

export type Tx = TransactionClient;

const symbol = Symbol();

type SqliteTransactionConfig = Readonly<{
    maxRetries: number;
    maxWaitMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    timeoutMs: number;
    totalRetryBudgetMs: number;
}>;

const DEFAULT_SQLITE_TRANSACTION_MAX_RETRIES = 8;
const DEFAULT_SQLITE_TRANSACTION_MAX_WAIT_MS = 5_000;
const DEFAULT_SQLITE_TRANSACTION_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_SQLITE_TRANSACTION_RETRY_MAX_DELAY_MS = 800;
const DEFAULT_SQLITE_TRANSACTION_TIMEOUT_MS = 10_000;
// Keep default inTx retry scheduling inside request/client timeout envelopes; raise via env only for known background paths.
const DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS = 25_000;

function readSqliteTransactionConfigFromEnv(env: NodeJS.ProcessEnv): SqliteTransactionConfig {
    const retryBaseDelayMs = parseIntEnv(
        env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_BASE_DELAY_MS,
        DEFAULT_SQLITE_TRANSACTION_RETRY_BASE_DELAY_MS,
        { min: 0, max: 60_000 },
    );

    return {
        maxRetries: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_RETRIES ?? env.HAPPY_DB_TX_MAX_RETRIES,
            DEFAULT_SQLITE_TRANSACTION_MAX_RETRIES,
            { min: 0, max: 100 },
        ),
        maxWaitMs: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_WAIT_MS ?? env.HAPPY_DB_TX_MAX_WAIT_MS,
            DEFAULT_SQLITE_TRANSACTION_MAX_WAIT_MS,
            { min: 1_000, max: 600_000 },
        ),
        retryBaseDelayMs,
        retryMaxDelayMs: parseIntEnv(
            env.HAPPIER_DB_TX_RETRY_MAX_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_MAX_DELAY_MS,
            DEFAULT_SQLITE_TRANSACTION_RETRY_MAX_DELAY_MS,
            { min: retryBaseDelayMs, max: 600_000 },
        ),
        timeoutMs: parseIntEnv(
            env.HAPPIER_DB_TX_TIMEOUT_MS ?? env.HAPPY_DB_TX_TIMEOUT_MS,
            DEFAULT_SQLITE_TRANSACTION_TIMEOUT_MS,
            { min: 1_000, max: 600_000 },
        ),
        totalRetryBudgetMs: parseIntEnv(
            env.HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS ?? env.HAPPY_DB_TX_TOTAL_RETRY_BUDGET_MS,
            DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS,
            { min: 1, max: 600_000 },
        ),
    };
}

function resolveSqliteTransactionRetryDelayMs(
    attempt: number,
    config: Pick<SqliteTransactionConfig, "retryBaseDelayMs" | "retryMaxDelayMs">,
): number {
    return Math.min(config.retryMaxDelayMs, attempt * config.retryBaseDelayMs);
}

function canStartAnotherSqliteTransactionAttempt(params: Readonly<{
    config: SqliteTransactionConfig;
    retryDelayMs: number;
    startedAtMs: number;
}>): boolean {
    const elapsedMs = Math.max(0, Date.now() - params.startedAtMs);
    const nextAttemptBudgetMs = params.config.maxWaitMs + params.config.timeoutMs;
    return elapsedMs + params.retryDelayMs + nextAttemptBudgetMs <= params.config.totalRetryBudgetMs;
}

export function isRetryableTransactionError(params: Readonly<{ provider: string; err: unknown }>): boolean {
    if (isPrismaErrorCode(params.err, "P2034")) return true;

    if (params.provider === "sqlite") {
        if (isRetryableSqliteWriteError(params.err)) return true;
    }

    return false;
}

type AfterTxCallback = () => void | Promise<void>;

function logAfterTxCallbackFailure(error: unknown) {
    // The transaction is already committed, so the failure must not propagate,
    // but a silent drop here loses post-commit fan-out (socket updates etc.).
    warn({ module: "inTx", error }, "afterTx callback failed after commit");
}

export function afterTx(tx: Tx, callback: AfterTxCallback) {
    // Golden rule:
    // - Do NOT emit socket updates inside a DB transaction.
    // - Instead, schedule them with afterTx so they only fire after commit.
    //
    // `afterTx` is only valid for transactions created via `inTx()`.
    const callbacks = (tx as any)[symbol] as AfterTxCallback[] | undefined;
    if (!callbacks) {
        throw new Error('afterTx(tx, ...) called outside inTx() transaction');
    }
    callbacks.push(callback);
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const sqliteTransactionConfig = provider === "sqlite" ? readSqliteTransactionConfigFromEnv(process.env) : null;
    const maxRetries = sqliteTransactionConfig?.maxRetries ?? 3;
    const startedAtMs = Date.now();
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as AfterTxCallback[];
        return { result, callbacks };
    }
    while (true) {
        try {
            const txOpts = sqliteTransactionConfig
                ? { timeout: sqliteTransactionConfig.timeoutMs, maxWait: sqliteTransactionConfig.maxWaitMs }
                : { isolationLevel: "Serializable" as const, timeout: 10000 };
            let result = await db.$transaction(wrapped, txOpts);
            for (let callback of result.callbacks) {
                try {
                    // Callbacks stay fire-and-forget: async ones are not awaited, only
                    // observed so their rejections are logged instead of going unhandled.
                    const value = callback();
                    if (value instanceof Promise) {
                        value.catch(logAfterTxCallbackFailure);
                    }
                } catch (error) {
                    logAfterTxCallbackFailure(error);
                }
            }
            return result.result;
        } catch (e) {
            if (isRetryableTransactionError({ provider, err: e }) && counter < maxRetries) {
                const nextAttempt = counter + 1;
                const retryDelayMs = sqliteTransactionConfig
                    ? resolveSqliteTransactionRetryDelayMs(nextAttempt, sqliteTransactionConfig)
                    : nextAttempt * 100;
                if (
                    sqliteTransactionConfig &&
                    !canStartAnotherSqliteTransactionAttempt({
                        config: sqliteTransactionConfig,
                        retryDelayMs,
                        startedAtMs,
                    })
                ) {
                    throw e;
                }
                counter = nextAttempt;
                await delay(retryDelayMs);
                continue;
            }
            throw e;
        }
    }
}
