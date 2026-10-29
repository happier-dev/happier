import { TransactionConflictExhaustedError, TransactionAcquisitionUnavailableError, TransactionDeadlineExceededError, isTransactionDeadlineExceededError } from "@/storage/transactionErrors";
export { TransactionConflictExhaustedError, TransactionAcquisitionUnavailableError, TransactionDeadlineExceededError,
    isTransactionConflictExhaustedError, isTransactionAcquisitionUnavailableError, isTransactionDeadlineExceededError } from "@/storage/transactionErrors";
import { readDatabaseTransactionConfigFromEnv, resolveTransactionRetryDelayMs, type DatabaseTransactionConfig } from "@/config/databaseTransactions";
import { recordDatabaseTransactionRetry } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, getPooledTransactionAdmission, isPrismaErrorCode, prismaRuntime, withSqliteReadSnapshot, type TransactionClient } from "@/storage/prisma";
import { isLockAdmissionDeadlineExceededError, LockAdmissionDeadlineExceededError } from "@/utils/runtime/lock";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { log } from "@/utils/logging/log";
import { createWebLatencyTransactionAttempt, readWebLatencyRequestId, settleWebLatencyTransactionAttempt,
    timeWebLatencyPhase, type WebLatencyTransactionAttempt } from '@/utils/webLatencyTrace';
import { flushAccountChangesInTx } from '@/app/changes/markAccountChanged';

export type Tx = TransactionClient;
const transactionResultSymbol = Symbol('transaction-result');
/** Explicit projection of values that are allocated by terminal publication. */
export interface TransactionResult<T> {
    readonly [transactionResultSymbol]: true;
    resolveResult(): T;
}

export type ResolvedTransactionResult<T> = T extends TransactionResult<infer Result> ? Result : T;

export function transactionResult<T>(resolveResult: () => T): TransactionResult<T> {
    return { [transactionResultSymbol]: true, resolveResult };
}

function resolveTransactionResult<T>(value: T): ResolvedTransactionResult<T> {
    if (value && typeof value === 'object' && transactionResultSymbol in value
        && value[transactionResultSymbol] === true && 'resolveResult' in value
        && typeof value.resolveResult === 'function') {
        return value.resolveResult();
    }
    return value as ResolvedTransactionResult<T>;
}
export type InTxOptions = Readonly<{
    readOnly?: boolean;
    isolationLevel?: "Serializable" | "RepeatableRead" | "ReadCommitted";
    timeoutMs?: number;
    maxWaitMs?: number;
    deadlineAtMs?: number;
    transactionClass?: string;
    /** Refresh before each attempt; the returned fence precedes callback reads. */
    prepare?: () => Promise<(tx: Tx) => Promise<void>>;
}>;

/** A coherent read view, without certifying a serial ordering with writers. */
export async function inReadSnapshot<T>(read: (tx: Tx) => Promise<T>, options?: Pick<InTxOptions, "transactionClass">): Promise<T> {
    // A snapshot captures caller-owned data; only write transaction results
    // participate in terminal publication projection.
    const captured = await inTx(async tx => ({ value: await read(tx) }), {
        ...options,
        readOnly: true,
        isolationLevel: getDbProviderFromEnv(process.env, "postgres") === "postgres" ? "RepeatableRead" : "Serializable",
    });
    return captured.value;
}

export type TransactionReplayReason = "session-account-audience-changed"
    | "session-initial-access-admission-changed"
    | "discussion-participant-birth-admission-changed"
    | "automation-assignment-admission-changed"
    | "automation-event-source-status-conflict"
    | "hosted-artifact-removal-mode-changed"
    | "username-admission-changed"
    | "session-input-reply-progress-changed"
    | "autonomous-exchange-root-changed"
    | "follow-input-settlement-conflict"
    | "follow-rule-progress-conflict"
    | "follow-relation-progress-conflict"
    | "pending-activation-target-changed"
    | "transaction-account-audience-changed"
    | "directory-source-currentness-changed"
    | "usage-runtime-order-changed";

/** Abort the current transaction when its fenced audience no longer matches its reads. */
export class TransactionReplayRequiredError extends Error {
    constructor(readonly reason: TransactionReplayReason) {
        super("Database transaction must replay its current account audience");
        this.name = "TransactionReplayRequiredError";
    }
}

/** Thrown inside the interactive callback, whose rejection rolls back this
 * attempt. It must not masquerade as exhaustion of the containing request. */
class TransactionAttemptDeadlineExceededError extends Error {
    constructor() {
        super("Database transaction attempt deadline expired");
        this.name = "TransactionAttemptDeadlineExceededError";
    }
}

const symbol = Symbol();
interface TransactionContext extends TransactionContextView {
    callbacks: (() => void)[];
}

export interface TransactionContextView {
    readonly readOnly: boolean;
    readonly transactionClass: string;
    readonly requestId: string | undefined;
}

/** Native Prisma transaction proxies may share their property backing target. */
export function getTransactionContext(tx: Tx): object;
export function getTransactionContext(tx: Tx, options: Readonly<{ optional: true }>): TransactionContextView | undefined;
export function getTransactionContext(tx: Tx, options?: Readonly<{ optional: true }>): object | undefined {
    const context = (tx as Tx & { [symbol]?: TransactionContext })[symbol];
    if (!context && !options?.optional) throw new Error('Account publication requires an inTx() transaction');
    return context;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error && typeof err.message === "string") return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const value = (err as { message?: unknown }).message;
        if (typeof value === "string") return value;
    }
    return "";
}

export function readPostgresTransactionSqlState(error: unknown): "40001" | "40P01" | "55P03" | "57014" | undefined {
    if (isPrismaErrorCode(error, "40001")) return "40001";
    if (isPrismaErrorCode(error, "40P01")) return "40P01";
    if (isPrismaErrorCode(error, "55P03")) return "55P03";
    if (isPrismaErrorCode(error, "57014")) return "57014";
    // Raw queries preserve the server SQLSTATE in Prisma P2010 metadata.
    if (isPrismaErrorCode(error, "P2010") && typeof error === "object" && error !== null && "meta" in error) {
        const meta = error.meta;
        if (meta && typeof meta === "object" && "code" in meta
            && (meta.code === "40001" || meta.code === "40P01" || meta.code === "55P03" || meta.code === "57014")) return meta.code;
    }
    // Prisma's unknown-request wrapper exposes the native PostgresError code
    // in its driver diagnostic. Arbitrary application messages are not proof.
    if (error instanceof prismaRuntime.PrismaClientUnknownRequestError) {
        const code = /\bPostgresError\s*\{\s*code:\s*"(40001|40P01|55P03|57014)"/.exec(error.message)?.[1];
        if (code === "40001" || code === "40P01" || code === "55P03" || code === "57014") return code;
    }
    return undefined;
}

/** Emit only fixed driver failure text: wrappers and DETAIL may contain SQL or values. */
function readContentFreeDriverErrorMessage(error: unknown): string | undefined {
    const meta = typeof error === 'object' && error !== null && 'meta' in error ? error.meta : undefined;
    const message = typeof meta === 'object' && meta !== null && 'message' in meta && typeof meta.message === 'string'
        ? meta.message : errorMessage(error);
    return [
        'could not serialize access due to read/write dependencies among transactions',
        'could not serialize access due to concurrent update',
        'could not serialize access due to concurrent delete',
        'could not serialize access due to concurrent ddl',
        'deadlock detected',
        'canceling statement due to lock timeout',
        'canceling statement due to statement timeout',
    ].find(summary => message.toLowerCase().includes(summary));
}

export function isRetryableTransactionError(params: Readonly<{ provider: string; err: unknown }>): boolean {
    // Acquisition-shaped P2028 requires callback-entry context, which only inTx owns.
    if (isTransactionAcquisitionTimeout(params.err)) return false;
    if (params.provider === "postgres") {
        const sqlState = readPostgresTransactionSqlState(params.err);
        // Only genuine concurrency aborts can replay the complete operation.
        // Expired execution/acquisition and ordinary lock timeouts settle;
        // unstructured messages cannot authorize replay of an unknown outcome.
        return isPrismaErrorCode(params.err, "P2034") || sqlState === "40001" || sqlState === "40P01";
    }

    if (isPrismaErrorCode(params.err, "P2034")) return true;
    if (isExpiredTransactionError(params.err)) return true;
    if (params.err instanceof TransactionAttemptDeadlineExceededError) return true;

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

/** Prisma names the operation that found the expired transaction: query, batch query or commit. */
function isExpiredTransactionError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2028")
        && readTransactionErrorMessage(error).toLowerCase()
            .includes("cannot be executed on an expired transaction");
}

function isMissingPrismaTransactionError(error: unknown): boolean {
    return error instanceof prismaRuntime.PrismaClientKnownRequestError
        && error.code === "P2028"
        && readTransactionErrorMessage(error).startsWith("Transaction not found.");
}

export function isTransactionAcquisitionTimeout(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2028")
        && readTransactionErrorMessage(error).toLowerCase().includes("unable to start a transaction");
}


export function afterTx(tx: Tx, callback: () => void) {
    // Golden rule:
    // - Do NOT emit socket updates inside a DB transaction.
    // - Instead, schedule them with afterTx so they only fire after commit.
    //
    // `afterTx` is only valid for transactions created via `inTx()`.
    const context = (tx as Tx & { [symbol]?: TransactionContext })[symbol];
    if (!context) throw new Error('afterTx(tx, ...) called outside inTx() transaction');
    context.callbacks.push(callback);
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

async function prepareTransactionAttempt(
    prepare: NonNullable<InTxOptions["prepare"]>,
    deadlineAtMs?: number,
    transactionClass?: string,
) {
    // Apply the same attempt-admission deadline before preparation does IO;
    // the remaining budget is measured again before opening the transaction.
    if (deadlineAtMs !== undefined && Math.floor(deadlineAtMs - Date.now()) < 2) {
        throw new TransactionDeadlineExceededError(null, transactionClass);
    }
    return prepare();
}

async function withPostgresStatementBudget(tx: Tx, timeoutMs: number, startedAtMs: number): Promise<Tx> {
    // Utility commands leave the caller's first Serializable snapshot/fence
    // ordering intact. A SELECT set_config here would establish it too early.
    const [setting] = await tx.$queryRaw<Array<{ statement_timeout: string }>>`SHOW statement_timeout`;
    const match = /^(\d+)(ms|s|min|h|d)?$/.exec(setting.statement_timeout);
    if (!match) throw new Error("Invalid PostgreSQL statement_timeout setting");
    const multiplier = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000
        : match[2] === "min" ? 60_000 : match[2] === "s" ? 1_000 : 1;
    const configuredMs = Number(match[1]) * multiplier;
    // SHOW observed the already-enforced limit. Reapply only when the remaining
    // attempt budget becomes stricter; zero still needs a finite first setting.
    let appliedTimeoutMs = configuredMs;
    const readStatementTimeoutMs = () => {
        const remainingMs = Math.floor(timeoutMs - (Date.now() - startedAtMs));
        if (remainingMs < 1) throw new TransactionAttemptDeadlineExceededError();
        return configuredMs === 0 ? remainingMs : Math.min(configuredMs, remainingMs);
    };
    const refresh = async () => {
        const statementTimeoutMs = readStatementTimeoutMs();
        if (statementTimeoutMs === appliedTimeoutMs) return;
        // PostgreSQL SET accepts no bound parameter. This integer comes only
        // from the validated existing SQL and transaction budgets.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
        appliedTimeoutMs = statementTimeoutMs;
    };
    // Still refuse expiry before entering domain work. Apply the LOCAL setting
    // only at the first awaited SQL below: an eager SET can be superseded by
    // that query's remaining-budget refresh without protecting any statement.
    readStatementTimeoutMs();

    // A transaction has one SQL connection, including inside Promise.all.
    // Keep each SET adjacent to its operation: queued operations must measure
    // their remaining budget after earlier SQL has finished, not before it.
    let pending = Promise.resolve();
    const schedule = (operation: () => PromiseLike<unknown>) => {
        const result = pending.then(async () => { await refresh(); return await operation(); });
        pending = result.then(() => {}, () => {});
        return result;
    };
    const wrapQuery = (query: unknown): unknown => {
        if (!query || typeof query !== "object" || !("then" in query) || typeof query.then !== "function") return query;
        let running: Promise<unknown> | undefined;
        const run = () => running ??= schedule(() => query as PromiseLike<unknown>);
        return new Proxy(query, {
            get(target, property) {
                if (property === "then" || property === "catch" || property === "finally") {
                    return (...args: unknown[]) => {
                        const promise = run();
                        return Reflect.apply(Reflect.get(promise, property, promise), promise, args);
                    };
                }
                const value = Reflect.get(target, property, target);
                // Prisma's fluent relation methods create another lazy query.
                return typeof value === "function"
                    ? (...args: unknown[]) => wrapQuery(Reflect.apply(value, target, args)) : value;
            },
        });
    };
    const wrapMethods = <T extends object>(target: T): T => {
        const methods = new Map<PropertyKey, unknown>();
        return new Proxy(target, {
            get(owner, property) {
                const value = Reflect.get(owner, property, owner);
                if (typeof value !== "function") return value;
                if (!methods.has(property)) methods.set(property,
                    (...args: unknown[]) => wrapQuery(Reflect.apply(value, owner, args)));
                return methods.get(property);
            },
        });
    };
    const raw = wrapMethods(tx);
    const delegates = new Map<PropertyKey, object>();
    return new Proxy(tx, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof property !== "string") return value;
            if (property.startsWith("$")) return Reflect.get(raw, property, raw);
            if (!value || typeof value !== "object") return value;
            if (!delegates.has(property)) delegates.set(property, wrapMethods(value));
            return delegates.get(property);
        },
    });
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>, options?: InTxOptions): Promise<ResolvedTransactionResult<T>> {
    const startedAtMs = Date.now();
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider === "sqlite" && options?.readOnly) {
        if (options.prepare) {
            const fence = await prepareTransactionAttempt(options.prepare, options.deadlineAtMs, options.transactionClass);
            return await withSqliteReadSnapshot(async tx => {
                await fence(tx);
                return resolveTransactionResult(await fn(tx));
            }, { deadlineAtMs: options.deadlineAtMs });
        }
        return await withSqliteReadSnapshot(async tx => resolveTransactionResult(await fn(tx)), { deadlineAtMs: options.deadlineAtMs });
    }
    const transactionConfig = readDatabaseTransactionConfigFromEnv(process.env, provider);
    const configuredMaxWaitMs = options?.maxWaitMs ?? transactionConfig.maxWaitMs;
    const configuredTimeoutMs = options?.timeoutMs ?? transactionConfig.timeoutMs;
    // One operation owns preparation, admission, execution and retry backoff.
    // Legacy PostgreSQL callers derive it from the existing phase allowances;
    // never import SQLite's total retry budget or renew it on replay.
    const deadlineAtMs = options?.deadlineAtMs ?? (provider === "postgres"
        ? startedAtMs + configuredMaxWaitMs + configuredTimeoutMs : undefined);
    const admission = provider === "postgres" ? getPooledTransactionAdmission() : undefined;
    let counter = 0;
    let ambiguousAttemptFailure: { error: unknown } | undefined;
    let transactionCallbackEntered = false;
    let transactionCallbackCompleted = false;
    let attemptTrace: WebLatencyTransactionAttempt | undefined;
    let wrapped = async (tx: Tx, timeoutMs: number, acquisitionDeadlineAtMs: number, fence?: (tx: Tx) => Promise<void>, trace?: WebLatencyTransactionAttempt) => {
        const attemptStartedAtMs = Date.now();
        if (trace) trace.nativeCallbackStartedAtMs = attemptStartedAtMs;
        try {
            if (
                deadlineAtMs !== undefined
                && attemptStartedAtMs >= deadlineAtMs
            ) {
                throw new TransactionDeadlineExceededError(null, options?.transactionClass);
            }
            // Prisma maxWait bounds its pool, but a proxy-queued BEGIN can enter
            // later. Reject before admitting user work; callback rejection rolls
            // the native transaction back through the existing acquisition path.
            if (attemptStartedAtMs >= acquisitionDeadlineAtMs) throw new LockAdmissionDeadlineExceededError();
            transactionCallbackEntered = true;
            if (provider === "postgres" && options?.readOnly) {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            }
            if (provider === "postgres") {
                // Prisma's interactive deadline does not interrupt an in-flight SQL
                // lock wait. Charge earlier operations to the same execution budget so
                // an expired callback cannot retain a pooled connection indefinitely.
                tx = await withPostgresStatementBudget(tx, timeoutMs, attemptStartedAtMs);
            }
            // Keep all per-attempt state on this closure-owned object, rather than
            // assigning through Prisma's proxy onto a potentially shared client.
            const context: TransactionContext = {
                callbacks: [], readOnly: options?.readOnly === true,
                transactionClass: options?.transactionClass ?? "unspecified",
                requestId: readWebLatencyRequestId(),
            };
            tx = new Proxy(tx, {
                get(target, property) {
                    return property === symbol ? context : Reflect.get(target, property, target);
                },
            });
            if (fence) await fence(tx);
            let result = await timeWebLatencyPhase('db.transaction.callback', () => fn(tx), options?.transactionClass);
            await flushAccountChangesInTx(tx);
            if (trace) trace.publicationCompletedAtMs = Date.now();
            const resolvedResult = resolveTransactionResult(result);
            let callbacks = context.callbacks;
            transactionCallbackCompleted = true;
            return { result: resolvedResult, callbacks };
        } finally {
            if (trace) trace.nativeCallbackEndedAtMs = Date.now();
        }
    }
    while (true) {
        transactionCallbackEntered = false;
        transactionCallbackCompleted = false;
        attemptTrace = process.env.HAPPIER_WEB_LATENCY_TRACE === '1' ? createWebLatencyTransactionAttempt({
            transactionClass: options?.transactionClass ?? 'unspecified', provider,
            isolationLevel: provider === 'sqlite' ? null : options?.isolationLevel ?? 'ReadCommitted',
            entryAtMs: startedAtMs, deadlineAtMs: deadlineAtMs ?? null, configuredMaxWaitMs, configuredTimeoutMs,
        }) : undefined;
        try {
            const fence = options?.prepare
                ? await prepareTransactionAttempt(options.prepare, deadlineAtMs, options.transactionClass)
                : undefined;
            const acquisitionStartedAtMs = Date.now();
            if (attemptTrace) attemptTrace.admissionSubmittedAtMs = acquisitionStartedAtMs;
            const acquisitionDeadlineAtMs = Math.min(acquisitionStartedAtMs + configuredMaxWaitMs, deadlineAtMs ?? Infinity);
            const attempt = async () => {
                if (attemptTrace) attemptTrace.admissionAcquiredAtMs = Date.now();
                const remainingMs = deadlineAtMs === undefined
                    ? null
                    : Math.floor(deadlineAtMs - Date.now());
                if (remainingMs !== null && remainingMs < 2) {
                    throw new TransactionDeadlineExceededError(null, options?.transactionClass);
                }
                // Local admission and Prisma acquisition consume the same budget.
                // Recompute after queueing, before opening any pooled transaction.
                const remainingMaxWaitMs = admission
                    ? configuredMaxWaitMs - (Date.now() - acquisitionStartedAtMs) : configuredMaxWaitMs;
                if (remainingMaxWaitMs < 1) throw new LockAdmissionDeadlineExceededError();
                const boundedMaxWaitMs = remainingMs === null
                    ? remainingMaxWaitMs
                    : Math.max(1, Math.min(remainingMaxWaitMs, Math.floor(remainingMs / 3)));
                const boundedTimeoutMs = remainingMs === null
                    ? configuredTimeoutMs
                    : Math.max(1, Math.min(configuredTimeoutMs, remainingMs - boundedMaxWaitMs));
                const attemptAcquisitionDeadlineAtMs = Math.min(acquisitionDeadlineAtMs, Date.now() + boundedMaxWaitMs);
                // Admission stability precedes domain reads; resource locks/CAS
                // protect domain writes and Account publication flushes last.
                // Keep Serializable opt-in for predicates not protected by those
                // locks/CAS. Isolation cannot change after a caller has read rows.
                // Coherent readers use inReadSnapshot rather than joining SSI.
                const txOpts =
                    provider === "sqlite"
                        ? {
                              timeout: boundedTimeoutMs,
                              maxWait: boundedMaxWaitMs,
                          }
                        : {
                              isolationLevel: options?.isolationLevel ?? "ReadCommitted",
                              timeout: boundedTimeoutMs,
                              maxWait: boundedMaxWaitMs,
                          };
                if (attemptTrace) {
                    attemptTrace.boundedMaxWaitMs = boundedMaxWaitMs;
                    attemptTrace.boundedTimeoutMs = boundedTimeoutMs;
                }
                const trace = attemptTrace;
                return await timeWebLatencyPhase('db.transaction.attempt', () => db.$transaction(tx => wrapped(tx, boundedTimeoutMs, attemptAcquisitionDeadlineAtMs, fence, trace), txOpts), options?.transactionClass, trace);
            };
            const result = admission
                ? await admission.inLock(attempt, { deadlineAtMs: acquisitionDeadlineAtMs })
                : await attempt();
            if (attemptTrace) settleWebLatencyTransactionAttempt(attemptTrace, 'committed');
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch (callbackError) {
                    // The committed result stands, so a failed after-commit
                    // callback never fails the transaction. It is still the
                    // only signal that a post-commit consequence — a socket
                    // eviction, an alert, a projection refresh — did not run,
                    // so it is reported rather than discarded.
                    log(
                        { module: "storage-tx", level: "error" },
                        "after-commit callback failed",
                        callbackError,
                    );
                }
            }
            return result.result;
        } catch (e) {
            // P2024 is the pool-acquisition form of the same pre-callback
            // failure. Reuse this owner's recovery budget and no-effect result;
            // a failure after callback entry must retain its outcome certainty.
            const acquisitionTimeout = !transactionCallbackEntered
                && (isLockAdmissionDeadlineExceededError(e) || isTransactionAcquisitionTimeout(e) || isPrismaErrorCode(e, "P2024"));
            const sqlState = provider === "postgres" ? readPostgresTransactionSqlState(e) : undefined;
            // Prisma evicts old closed-transaction diagnostics under churn. A
            // missing native transaction before our callback completes cannot
            // have committed: only $transaction may commit after that return.
            // After the return, the same error remains an unknown outcome.
            const missingBeforeCommit = transactionCallbackEntered && !transactionCallbackCompleted
                && isMissingPrismaTransactionError(e);
            const retryable = (provider !== "postgres" && (acquisitionTimeout || missingBeforeCommit))
                || (transactionCallbackEntered && e instanceof TransactionReplayRequiredError)
                || isRetryableTransactionError({ provider, err: e });
            const confirmedRollback = (transactionCallbackEntered && e instanceof TransactionReplayRequiredError)
                || missingBeforeCommit
                || (transactionCallbackEntered && e instanceof TransactionAttemptDeadlineExceededError)
                || isPrismaErrorCode(e, "P2034")
                // Prisma has already rolled back an expired interactive
                // transaction. Other P2028 states do not prove no commit.
                || isExpiredTransactionError(e)
                || sqlState === "40001" || sqlState === "40P01" || sqlState === "55P03" || sqlState === "57014";
            if (attemptTrace) settleWebLatencyTransactionAttempt(attemptTrace,
                acquisitionTimeout ? 'not-started' : confirmedRollback ? 'rolled-back' : 'unknown', e, sqlState);
            // Retryable transport failures and legacy message heuristics do
            // not prove an earlier attempt failed to commit. Later rollback or
            // acquisition failure cannot erase that unknown outcome.
            if (retryable && !acquisitionTimeout && !confirmedRollback) {
                ambiguousAttemptFailure ??= { error: e };
            }
            const throwExhausted = (): never => {
                if (isTransactionDeadlineExceededError(e)) {
                    throw ambiguousAttemptFailure
                        ? new TransactionDeadlineExceededError(ambiguousAttemptFailure.error, options?.transactionClass)
                        : e;
                }
                if (acquisitionTimeout && options?.deadlineAtMs !== undefined) {
                    throw new TransactionDeadlineExceededError(ambiguousAttemptFailure?.error ?? e, options?.transactionClass);
                }
                if (ambiguousAttemptFailure) throw ambiguousAttemptFailure.error;
                if (confirmedRollback || acquisitionTimeout) {
                    const driverErrorMessage = sqlState ? readContentFreeDriverErrorMessage(e) : undefined;
                    // A query-cancel/lock SQLSTATE alone does not identify a
                    // deadline (for example, user cancellation or NOWAIT).
                    const expired = isExpiredTransactionError(e) || e instanceof TransactionAttemptDeadlineExceededError
                        || (sqlState === "57014" && driverErrorMessage === "canceling statement due to statement timeout")
                        || (sqlState === "55P03" && driverErrorMessage === "canceling statement due to lock timeout");
                    const meta = typeof e === "object" && e !== null && "meta" in e ? e.meta : undefined;
                    const failedStatementRelation = typeof meta === "object" && meta !== null
                        && "modelName" in meta && typeof meta.modelName === "string" ? meta.modelName : undefined;
                    const prismaCode = typeof e === "object" && e !== null && "code" in e
                        && typeof e.code === "string" && /^P\d{4}$/.test(e.code) ? e.code : undefined;
                    // Reuse the recovery owner's classifications, never raw
                    // Prisma messages (which may contain SQL and parameters).
                    const prismaTransactionErrorKind = prismaCode !== "P2028" ? undefined
                        : acquisitionTimeout ? "acquisition-unavailable"
                        : isExpiredTransactionError(e) ? "expired-timeout"
                        : isMissingPrismaTransactionError(e) ? "transaction-not-found" : "unclassified";
                    log({
                        module: "storage-tx", level: "warn", event: acquisitionTimeout ? "transaction-acquisition" : "transaction-rollback",
                        transactionClass: options?.transactionClass ?? "unspecified",
                        provider, sqlState, prismaCode, prismaTransactionErrorKind, failedStatementRelation,
                        outcome: acquisitionTimeout ? "acquisition-unavailable" : expired ? "deadline-exceeded" : "conflict-exhausted",
                        driverErrorCode: sqlState,
                        driverErrorMessage,
                        isolationLevel: provider === "sqlite" ? undefined : options?.isolationLevel ?? "ReadCommitted",
                        readOnly: options?.readOnly === true,
                        attempts: counter + 1,
                        ...(e instanceof TransactionReplayRequiredError ? { replayReason: e.reason } : {}),
                    }, acquisitionTimeout ? "Database transaction acquisition is unavailable"
                        : expired ? "Database transaction deadline expired" : "Database transaction rollback recovery exhausted");
                    if (acquisitionTimeout) throw new TransactionAcquisitionUnavailableError(e);
                    if (expired) throw new TransactionDeadlineExceededError(e, options?.transactionClass);
                    throw new TransactionConflictExhaustedError(e);
                }
                throw e;
            };
            if (provider === "postgres" && (confirmedRollback || acquisitionTimeout)
                && (!retryable || (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs))) {
                // Execution/admission exhaustion never opens another window.
                // Keep this owner's established rollback/availability certainty.
                throwExhausted();
            }
            if (
                options?.deadlineAtMs !== undefined
                && transactionCallbackEntered
                && (Date.now() >= options.deadlineAtMs || isPrismaErrorCode(e, "P2028") || sqlState === "57014")
            ) {
                throw new TransactionDeadlineExceededError(ambiguousAttemptFailure?.error ?? e, options?.transactionClass);
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
                    throwExhausted();
                }
                if (deadlineAtMs !== undefined && Date.now() + retryDelayMs >= deadlineAtMs) {
                    if (provider === "postgres") throwExhausted();
                    throw new TransactionDeadlineExceededError(ambiguousAttemptFailure?.error ?? e, options?.transactionClass);
                }
                counter = nextAttempt;
                recordDatabaseTransactionRetry(provider);
                await delay(retryDelayMs);
                continue;
            }
            throwExhausted();
        }
    }
}
