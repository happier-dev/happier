import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { debug, warn } from "@/utils/logging/log";

export type Tx = TransactionClient;

export const IN_TX_OPERATION_LABELS = {
    machinePresenceBatch: "machine.presence.batch",
    providerAccountUsageWrite: "provider-account.usage.write",
    sessionMessageWrite: "session.message.write",
    sessionOrganizationPin: "session.organization.pin",
    sessionPublisherPresence: "session.publisher-presence",
    sessionSystemRecordWrite: "session.system-record.write",
    usageReportWrite: "usage-report.write",
} as const;

export type InTxOperationLabel = typeof IN_TX_OPERATION_LABELS[keyof typeof IN_TX_OPERATION_LABELS];

type ActiveTransactionPhase = "acquisition-or-transaction" | "body" | "settlement";

type ActiveTransactionAttribution = Readonly<{
    operation: InTxOperationLabel;
    phase: ActiveTransactionPhase;
    startedAtMs: number;
}>;

const activeTransactionAttributions = new Map<symbol, ActiveTransactionAttribution>();

function beginTransactionAttribution(
    operation: InTxOperationLabel,
    phase: ActiveTransactionPhase,
): symbol {
    const token = Symbol(operation);
    activeTransactionAttributions.set(token, { operation, phase, startedAtMs: Date.now() });
    return token;
}

function updateTransactionAttributionPhase(token: symbol, phase: ActiveTransactionPhase): void {
    const current = activeTransactionAttributions.get(token);
    if (!current) return;
    activeTransactionAttributions.set(token, { ...current, phase });
}

function endTransactionAttribution(token: symbol | null): void {
    if (token) activeTransactionAttributions.delete(token);
}

function snapshotActiveTransactionAttributions(): readonly Readonly<{
    operation: InTxOperationLabel;
    phase: ActiveTransactionPhase;
    activeMs: number;
}>[] {
    const observedAtMs = Date.now();
    return [...activeTransactionAttributions.values()]
        .map((entry) => ({
            operation: entry.operation,
            phase: entry.phase,
            activeMs: Math.max(0, observedAtMs - entry.startedAtMs),
        }))
        .sort((left, right) => (
            left.operation.localeCompare(right.operation)
            || left.phase.localeCompare(right.phase)
            || left.activeMs - right.activeMs
        ));
}

/**
 * Shares transaction attribution with a transaction whose API does not expose an interactive
 * callback boundary. The phase intentionally remains `acquisition-or-transaction`: those phases
 * cannot be separated without changing that transaction's semantics.
 */
export async function runWithTransactionAttribution<T>(
    operation: InTxOperationLabel,
    action: () => Promise<T>,
): Promise<T> {
    const token = beginTransactionAttribution(operation, "acquisition-or-transaction");
    try {
        return await action();
    } finally {
        endTransactionAttribution(token);
    }
}

export type InTxOptions = Readonly<{
    deadlineAtMs?: number;
    /** Closed, non-sensitive owner labels only; no request, entity, SQL, or error data. */
    diagnostics?: Readonly<{
        operation: InTxOperationLabel;
    }>;
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
    // Acquisition-shaped P2028 requires callback-entry context, which only inTx owns.
    if (isTransactionAcquisitionTimeout(params.err)) return false;
    if (isPrismaErrorCode(params.err, "P2034")) return true;

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
    return error instanceof Error ? error.message : "";
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

function resolveBoundedTransactionOptions(params: Readonly<{
    deadlineAtMs: number;
    maxWaitMs: number;
    timeoutMs: number;
}>): Readonly<{ maxWait: number; timeout: number }> {
    const remainingMs = Math.floor(params.deadlineAtMs - Date.now());
    if (remainingMs < 2) throw new TransactionDeadlineExceededError(null);
    const maxWait = Math.max(1, Math.min(params.maxWaitMs, Math.floor(remainingMs / 3)));
    return {
        maxWait,
        timeout: Math.max(1, Math.min(params.timeoutMs, remainingMs - maxWait)),
    };
}

export function isTransactionDeadlineExceededError(error: unknown): error is TransactionDeadlineExceededError {
    return error instanceof TransactionDeadlineExceededError;
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>, options: InTxOptions = {}): Promise<T> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const sqliteTransactionConfig = provider === "sqlite" ? readSqliteTransactionConfigFromEnv(process.env) : null;
    const maxRetries = sqliteTransactionConfig?.maxRetries ?? 3;
    const startedAtMs = Date.now();
    let counter = 0;
    let transactionCallbackEntered = false;
    let attemptStartedAtMs = startedAtMs;
    let callbackEnteredAtMs: number | null = null;
    let callbackExitedAtMs: number | null = null;
    let activeAttributionToken: symbol | null = null;
    let retryFailurePhase: "acquisition" | "body" | "settlement" | null = null;
    let lastAcquisitionAttributions: ReturnType<typeof snapshotActiveTransactionAttributions> = [];
    const diagnostics = options.diagnostics;
    const writeDebug = (fields: Readonly<Record<string, unknown>>, message: string): void => {
        if (!diagnostics) return;
        debug({
            module: "storage",
            event: "database-transaction-attribution",
            operation: diagnostics.operation,
            ...fields,
        }, message);
    };
    const writeWarning = (fields: Readonly<Record<string, unknown>>): void => {
        if (!diagnostics) return;
        warn({
            module: "storage",
            event: "database-transaction-attribution",
            operation: diagnostics.operation,
            ...fields,
        }, "Database transaction attribution warning");
    };
    const withAcquisitionAttribution = <T extends Readonly<Record<string, unknown>>>(fields: T): T & Readonly<{
        holderAttribution: "labeled-active-operations" | "unattributed";
        activeTransactions: ReturnType<typeof snapshotActiveTransactionAttributions>;
    }> => ({
        ...fields,
        holderAttribution: lastAcquisitionAttributions.length > 0
            ? "labeled-active-operations"
            : "unattributed",
        activeTransactions: lastAcquisitionAttributions,
    });
    const currentFailurePhase = (): "acquisition" | "body" | "settlement" => {
        if (callbackEnteredAtMs === null) return "acquisition";
        return callbackExitedAtMs === null ? "body" : "settlement";
    };
    const writeFailureWarning = (
        phase: "acquisition" | "body" | "settlement",
        failure: "acquisition_unavailable" | "deadline_exceeded" | "retry_budget_exhausted" | "transaction_failed",
    ): void => {
        const fields = {
            phase,
            outcome: "failed",
            failure,
            attemptCount: counter + 1,
            totalMs: Date.now() - startedAtMs,
        } as const;
        writeWarning(phase === "acquisition" ? withAcquisitionAttribution(fields) : fields);
    };
    let wrapped = async (tx: Tx) => {
        transactionCallbackEntered = true;
        callbackEnteredAtMs = Date.now();
        if (diagnostics) {
            activeAttributionToken = beginTransactionAttribution(diagnostics.operation, "body");
        }
        writeDebug({ phase: "body", state: "started", attemptCount: counter + 1 }, "Database transaction phase");
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        callbackExitedAtMs = Date.now();
        if (activeAttributionToken) {
            updateTransactionAttributionPhase(activeAttributionToken, "settlement");
        }
        writeDebug({ phase: "settlement", state: "started", attemptCount: counter + 1 }, "Database transaction phase");
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        transactionCallbackEntered = false;
        attemptStartedAtMs = Date.now();
        callbackEnteredAtMs = null;
        callbackExitedAtMs = null;
        activeAttributionToken = null;
        writeDebug({ phase: "acquisition", state: "started", attemptCount: counter + 1 }, "Database transaction phase");
        try {
            const bounded = options.deadlineAtMs === undefined
                ? null
                : resolveBoundedTransactionOptions({
                    deadlineAtMs: options.deadlineAtMs,
                    maxWaitMs: sqliteTransactionConfig?.maxWaitMs ?? 2_000,
                    timeoutMs: sqliteTransactionConfig?.timeoutMs ?? 10_000,
                });
            const txOpts = sqliteTransactionConfig
                ? {
                    timeout: bounded?.timeout ?? sqliteTransactionConfig.timeoutMs,
                    maxWait: bounded?.maxWait ?? sqliteTransactionConfig.maxWaitMs,
                }
                : {
                    isolationLevel: "Serializable" as const,
                    timeout: bounded?.timeout ?? 10_000,
                    ...(bounded ? { maxWait: bounded.maxWait } : {}),
                };
            let result = await db.$transaction(wrapped, txOpts);
            const settledAtMs = Date.now();
            endTransactionAttribution(activeAttributionToken);
            activeAttributionToken = null;
            const acquisitionMs = callbackEnteredAtMs === null
                ? settledAtMs - attemptStartedAtMs
                : callbackEnteredAtMs - attemptStartedAtMs;
            const bodyMs = callbackEnteredAtMs === null
                ? 0
                : (callbackExitedAtMs ?? settledAtMs) - callbackEnteredAtMs;
            const settlementMs = callbackExitedAtMs === null ? 0 : settledAtMs - callbackExitedAtMs;
            const settlementFields = {
                phase: retryFailurePhase ?? "settled",
                outcome: counter > 0 ? "succeeded_after_retry" : "succeeded",
                attemptCount: counter + 1,
                totalMs: settledAtMs - startedAtMs,
                acquisitionMs,
                bodyMs,
                settlementMs,
            } as const;
            if (counter > 0) {
                writeWarning(retryFailurePhase === "acquisition"
                    ? withAcquisitionAttribution(settlementFields)
                    : settlementFields);
            } else {
                writeDebug(settlementFields, "Database transaction settled");
            }
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch {
                    // Ignore callback failures; transactional result is already committed.
                }
            }
            return result.result;
        } catch (e) {
            endTransactionAttribution(activeAttributionToken);
            activeAttributionToken = null;
            const acquisitionTimeout = isTransactionAcquisitionTimeout(e) && !transactionCallbackEntered;
            const retryable = acquisitionTimeout || isRetryableTransactionError({ provider, err: e });
            const failurePhase = currentFailurePhase();
            if (failurePhase === "acquisition") {
                lastAcquisitionAttributions = snapshotActiveTransactionAttributions();
            }
            if (
                options.deadlineAtMs !== undefined
                && transactionCallbackEntered
                && (
                    Date.now() >= options.deadlineAtMs
                    || isPrismaErrorCode(e, "P2028")
                )
            ) {
                writeFailureWarning(failurePhase, "deadline_exceeded");
                throw new TransactionDeadlineExceededError(e);
            }
            if (retryable && counter < maxRetries) {
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
                    if (acquisitionTimeout) {
                        writeFailureWarning(failurePhase, "acquisition_unavailable");
                        throw new TransactionAcquisitionUnavailableError(e);
                    }
                    writeFailureWarning(failurePhase, "retry_budget_exhausted");
                    throw e;
                }
                if (
                    options.deadlineAtMs !== undefined
                    && Date.now() + retryDelayMs >= options.deadlineAtMs
                ) {
                    writeFailureWarning(failurePhase, "deadline_exceeded");
                    throw new TransactionDeadlineExceededError(e);
                }
                retryFailurePhase = failurePhase;
                counter = nextAttempt;
                await delay(retryDelayMs);
                continue;
            }
            if (acquisitionTimeout) {
                if (options.deadlineAtMs !== undefined) {
                    writeFailureWarning(failurePhase, "deadline_exceeded");
                    throw new TransactionDeadlineExceededError(e);
                }
                writeFailureWarning(failurePhase, "acquisition_unavailable");
                throw new TransactionAcquisitionUnavailableError(e);
            }
            writeFailureWarning(failurePhase, "transaction_failed");
            throw e;
        }
    }
}
