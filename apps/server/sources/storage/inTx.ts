import { readDatabaseTransactionConfigFromEnv, resolveTransactionRetryDelayMs, type DatabaseTransactionConfig } from "@/config/databaseTransactions";
import { recordDatabaseTransactionRetry } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";

export type Tx = TransactionClient;
export type InTxOptions = Readonly<{
    isolationLevel?: "Serializable" | "ReadCommitted";
    timeoutMs?: number;
    maxWaitMs?: number;
}>;

export class TransactionAcquisitionUnavailableError extends Error {
    readonly code = "P2028";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction acquisition is temporarily unavailable");
        this.name = "TransactionAcquisitionUnavailableError";
        this.cause = cause;
    }
}

const symbol = Symbol();

function errorMessage(err: unknown): string {
    if (err instanceof Error && typeof err.message === "string") return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const value = (err as { message?: unknown }).message;
        if (typeof value === "string") return value;
    }
    return "";
}

export function isRetryableTransactionError(params: Readonly<{ provider: string; err: unknown }>): boolean {
    // Acquisition-shaped P2028 requires callback-entry context, which only inTx owns.
    if (isTransactionAcquisitionTimeout(params.err)) return false;
    if (isPrismaErrorCode(params.err, "P2034")) return true;

    if (params.provider === "postgres") {
        const message = errorMessage(params.err).toLowerCase();
        if (message.includes("could not serialize access")) return true;
        if (message.includes("serialization failure")) return true;
        if (message.includes("deadlock detected")) return true;
    }

    if (params.provider === "sqlite") {
        if (isRetryableSqliteWriteError(params.err)) return true;
    }

    return false;
}

function readTransactionErrorMessage(error: unknown): string {
    if (error && typeof error === "object" && "meta" in error) {
        const metaError = (error as { meta?: { error?: unknown } }).meta?.error;
        if (typeof metaError === "string") return metaError;
    }
    return errorMessage(error);
}

export function isTransactionAcquisitionTimeout(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2028")
        && readTransactionErrorMessage(error).toLowerCase().includes("unable to start a transaction");
}

export function isTransactionAcquisitionUnavailableError(
    error: unknown,
): error is TransactionAcquisitionUnavailableError {
    return error instanceof TransactionAcquisitionUnavailableError;
}

export function afterTx(tx: Tx, callback: () => void) {
    // Golden rule:
    // - Do NOT emit socket updates inside a DB transaction.
    // - Instead, schedule them with afterTx so they only fire after commit.
    //
    // `afterTx` is only valid for transactions created via `inTx()`.
    const callbacks = (tx as any)[symbol] as (() => void)[] | undefined;
    if (!callbacks) {
        throw new Error('afterTx(tx, ...) called outside inTx() transaction');
    }
    callbacks.push(callback);
}

function canStartAnotherSqliteTransactionAttempt(params: Readonly<{
    config: DatabaseTransactionConfig;
    retryDelayMs: number;
    startedAtMs: number;
}>): boolean {
    const elapsedMs = Date.now() - params.startedAtMs;
    const nextAttemptBudgetMs = params.config.maxWaitMs + params.config.timeoutMs;
    return elapsedMs + params.retryDelayMs + nextAttemptBudgetMs <= params.config.totalRetryBudgetMs;
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>, options?: InTxOptions): Promise<T> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const transactionConfig = readDatabaseTransactionConfigFromEnv(process.env, provider);
    let counter = 0;
    const startedAtMs = Date.now();
    let transactionCallbackEntered = false;
    let wrapped = async (tx: Tx) => {
        transactionCallbackEntered = true;
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        transactionCallbackEntered = false;
        try {
            const txOpts =
                provider === "sqlite"
                    ? {
                          timeout: options?.timeoutMs ?? transactionConfig.timeoutMs,
                          maxWait: options?.maxWaitMs ?? transactionConfig.maxWaitMs,
                      }
                    : {
                          isolationLevel: options?.isolationLevel ?? "Serializable",
                          timeout: options?.timeoutMs ?? transactionConfig.timeoutMs,
                          maxWait: options?.maxWaitMs ?? transactionConfig.maxWaitMs,
                      };
            let result = await db.$transaction(wrapped, txOpts);
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch {
                    // Ignore callback failures; transactional result is already committed.
                }
            }
            return result.result;
        } catch (e) {
            const acquisitionTimeout = isTransactionAcquisitionTimeout(e) && !transactionCallbackEntered;
            const retryable = acquisitionTimeout || isRetryableTransactionError({ provider, err: e });
            if (retryable && counter < transactionConfig.maxRetries) {
                const nextAttempt = counter + 1;
                const retryDelayMs = resolveTransactionRetryDelayMs({
                    attempt: nextAttempt,
                    retryBaseDelayMs: transactionConfig.retryBaseDelayMs,
                    retryMaxDelayMs: transactionConfig.retryMaxDelayMs,
                    retryJitterFactor: transactionConfig.retryJitterFactor,
                });
                if (
                    provider === "sqlite" &&
                    !canStartAnotherSqliteTransactionAttempt({
                        config: transactionConfig,
                        retryDelayMs,
                        startedAtMs,
                    })
                ) {
                    if (acquisitionTimeout) {
                        throw new TransactionAcquisitionUnavailableError(e);
                    }
                    throw e;
                }
                counter = nextAttempt;
                recordDatabaseTransactionRetry(provider);
                await delay(retryDelayMs);
                continue;
            }
            if (acquisitionTimeout) {
                throw new TransactionAcquisitionUnavailableError(e);
            }
            throw e;
        }
    }
}
