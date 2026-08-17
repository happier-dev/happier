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
    deadlineAtMs?: number;
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

export class TransactionDeadlineExceededError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction request deadline expired");
        this.name = "TransactionDeadlineExceededError";
        this.cause = cause;
    }
}

export function isTransactionDeadlineExceededError(error: unknown): error is TransactionDeadlineExceededError {
    return error instanceof TransactionDeadlineExceededError;
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
        if (
            options?.deadlineAtMs !== undefined
            && Date.now() >= options.deadlineAtMs
        ) {
            throw new TransactionDeadlineExceededError(null);
        }
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        transactionCallbackEntered = false;
        try {
            const remainingMs = options?.deadlineAtMs === undefined
                ? null
                : Math.floor(options.deadlineAtMs - Date.now());
            if (remainingMs !== null && remainingMs < 2) {
                throw new TransactionDeadlineExceededError(null);
            }
            const configuredMaxWaitMs = options?.maxWaitMs ?? transactionConfig.maxWaitMs;
            const configuredTimeoutMs = options?.timeoutMs ?? transactionConfig.timeoutMs;
            const boundedMaxWaitMs = remainingMs === null
                ? configuredMaxWaitMs
                : Math.max(1, Math.min(configuredMaxWaitMs, Math.floor(remainingMs / 3)));
            const boundedTimeoutMs = remainingMs === null
                ? configuredTimeoutMs
                : Math.max(1, Math.min(configuredTimeoutMs, remainingMs - boundedMaxWaitMs));
            const txOpts =
                provider === "sqlite"
                    ? {
                          timeout: boundedTimeoutMs,
                          maxWait: boundedMaxWaitMs,
                      }
                    : {
                          isolationLevel: options?.isolationLevel ?? "Serializable",
                          timeout: boundedTimeoutMs,
                          maxWait: boundedMaxWaitMs,
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
            if (
                options?.deadlineAtMs !== undefined
                && transactionCallbackEntered
                && (Date.now() >= options.deadlineAtMs || isPrismaErrorCode(e, "P2028"))
            ) {
                throw new TransactionDeadlineExceededError(e);
            }
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
                if (options?.deadlineAtMs !== undefined && Date.now() + retryDelayMs >= options.deadlineAtMs) {
                    throw new TransactionDeadlineExceededError(e);
                }
                counter = nextAttempt;
                recordDatabaseTransactionRetry(provider);
                await delay(retryDelayMs);
                continue;
            }
            if (acquisitionTimeout) {
                if (options?.deadlineAtMs !== undefined) throw new TransactionDeadlineExceededError(e);
                throw new TransactionAcquisitionUnavailableError(e);
            }
            throw e;
        }
    }
}
