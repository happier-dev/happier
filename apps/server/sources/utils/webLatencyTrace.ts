import { AsyncLocalStorage } from 'node:async_hooks';
import { log, logger } from '@/utils/logging/log';

const context = new AsyncLocalStorage<Readonly<{
    requestId?: string;
    sessionId?: string;
    sequence: { next: number };
    spanId?: number;
    parentSpanId?: number;
    attempt?: WebLatencyTransactionAttempt;
}>>();

/** Mutable capture belongs to one managed attempt; absent phases remain explicit. */
export interface WebLatencyTransactionAttempt {
    readonly requestId: string | undefined;
    readonly attemptId: number;
    readonly transactionClass: string;
    readonly provider: string;
    readonly isolationLevel: string | null;
    readonly entryAtMs: number;
    readonly deadlineAtMs: number | null;
    readonly configuredMaxWaitMs: number;
    readonly configuredTimeoutMs: number;
    admissionSubmittedAtMs: number | null;
    admissionAcquiredAtMs: number | null;
    nativeCallbackStartedAtMs: number | null;
    nativeCallbackEndedAtMs: number | null;
    publicationCompletedAtMs: number | null;
    boundedMaxWaitMs: number | null;
    boundedTimeoutMs: number | null;
    failedSqlPhase?: string;
}

let unattributedAttemptSequence = 0;

/** Call only behind the enabled check, so disabled attempts allocate nothing. */
export function createWebLatencyTransactionAttempt(input: Pick<WebLatencyTransactionAttempt,
    'transactionClass' | 'provider' | 'isolationLevel' | 'entryAtMs' | 'deadlineAtMs'
    | 'configuredMaxWaitMs' | 'configuredTimeoutMs'>): WebLatencyTransactionAttempt {
    const current = context.getStore();
    return { ...input, transactionClass: /^[a-z0-9_.-]+$/iu.test(input.transactionClass) ? input.transactionClass : 'unspecified',
        requestId: current?.requestId, attemptId: current ? ++current.sequence.next : ++unattributedAttemptSequence,
        admissionSubmittedAtMs: null, admissionAcquiredAtMs: null, nativeCallbackStartedAtMs: null,
        nativeCallbackEndedAtMs: null, publicationCompletedAtMs: null, boundedMaxWaitMs: null, boundedTimeoutMs: null };
}

/** One content-free settlement record, using inTx's existing outcome certainty. */
export function settleWebLatencyTransactionAttempt(attempt: WebLatencyTransactionAttempt,
    settlement: 'committed' | 'rolled-back' | 'not-started' | 'unknown', error?: unknown, sqlState?: string): void {
    try {
        if (!logger.isLevelEnabled('trace')) return;
        const meta = error && typeof error === 'object' && 'meta' in error ? error.meta : undefined;
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            && /^P\d{4}$/u.test(error.code) ? error.code : undefined;
        const message = meta && typeof meta === 'object' && 'error' in meta && typeof meta.error === 'string' ? meta.error
            : error instanceof Error ? error.message : '';
        // Parse only Prisma's fixed expired-transaction diagnostic. Never emit
        // the message, model names, SQL, parameters or arbitrary metadata.
        const discovery = code === 'P2028' ? /\b(query|batch query|commit) cannot be executed on an expired transaction/iu.exec(message) : null;
        const timing = discovery ? /The timeout for this transaction was (\d+) ms, however (\d+) ms passed/iu.exec(message) : null;
        const settledAtMs = Date.now();
        const nativeSqlState = sqlState ?? (meta && typeof meta === 'object' && 'code' in meta
            && typeof meta.code === 'string' && /^[0-9A-Z]{5}$/u.test(meta.code) ? meta.code : undefined);
        log({ level: 'trace', module: 'web-latency', phase: 'db.transaction.phases', ...attempt,
            settledAtMs, elapsedMs: settledAtMs - attempt.entryAtMs, settlement,
            ...(code ? { code } : {}), ...(nativeSqlState ? { sqlState: nativeSqlState } : {}),
            ...(discovery ? { discoveryPoint: discovery[1].toLowerCase() } : {}),
            ...(timing && Number.isSafeInteger(Number(timing[1])) && Number.isSafeInteger(Number(timing[2]))
                ? { nativeTimeoutMs: Number(timing[1]), nativeElapsedMs: Number(timing[2]) } : {}),
        }, '[web-latency]');
    } catch { /* Diagnostic only: preserve the transaction's result/failure. */ }
}

export function withWebLatencyTrace<T>(requestId: unknown, operation: () => T, sessionId?: string): T {
    // Nested action dispatch keeps the request's identity and span sequence.
    if (context.getStore()) return operation();
    // RPC forwards need the existing HTTP root even when detailed phase timing
    // is disabled. Emission and SQL annotation keep their own existing gate.
    return typeof requestId === 'string' && /^(?:req-[0-9a-z]+|(?:new-session-attempt-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(requestId)
        ? context.run({ requestId, ...(sessionId ? { sessionId } : {}), sequence: { next: 0 } }, operation) : operation();
}

/** The existing trace owner admits only content-free request identities. */
export function readWebLatencyRequestId(): string | undefined {
    return context.getStore()?.requestId;
}

/** Only validated trace identities enter SQL; never copy input, Session ids or query values. */
export function annotateWebLatencyQuery(sql: string): string {
    const current = context.getStore();
    return process.env.HAPPIER_WEB_LATENCY_TRACE === '1' && current?.requestId && current.spanId !== undefined
        ? `${sql}\n/* happier-web-latency:${current.requestId}:${current.spanId} */` : sql;
}

export async function timeWebLatencyPhase<T>(phase: string, operation: () => T | Promise<T>, transactionClass?: string,
    attempt?: WebLatencyTransactionAttempt): Promise<T> {
    if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return await operation();
    const started = performance.now();
    const parent: ReturnType<typeof context.getStore> = context.getStore()
        ?? (attempt ? { requestId: attempt.requestId, sequence: { next: attempt.attemptId } } : undefined);
    const span = parent ? { ...parent, spanId: ++parent.sequence.next,
        ...(parent.spanId === undefined ? {} : { parentSpanId: parent.spanId }), ...(attempt ? { attempt } : {}) } : undefined;
    let status: 'completed' | 'failed' = 'failed';
    let outcome: { code?: string; sqlState?: string } = {};
    try {
        const result = await (span ? context.run(span, operation) : operation());
        status = 'completed';
        return result;
    } catch (error) {
        if (span?.attempt && phase.startsWith('db.') && !phase.startsWith('db.transaction.')) span.attempt.failedSqlPhase = phase;
        // Diagnostic projection only: preserve the original exception and never log its message/SQL.
        try {
            if (typeof error === 'object' && error !== null) {
                if ('code' in error && typeof error.code === 'string' && /^P\d{4}$/u.test(error.code)) outcome.code = error.code;
                if ('meta' in error && typeof error.meta === 'object' && error.meta !== null
                    && 'code' in error.meta && typeof error.meta.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.meta.code)) {
                    outcome.sqlState = error.meta.code;
                }
            }
        } catch { /* Diagnostics cannot replace the operation's failure. */ }
        throw error;
    } finally {
        emitWebLatencyPhase(phase, performance.now() - started, transactionClass, status, outcome, span);
    }
}

/** Lifecycle hooks already own their stopwatch; keep their output and scope identical. */
export function recordWebLatencyPhase(phase: string, elapsedMs: number, transactionClass?: string): void {
    emitWebLatencyPhase(phase, elapsedMs, transactionClass);
}

function emitWebLatencyPhase(phase: string, elapsedMs: number, transactionClass?: string,
    status?: 'completed' | 'failed', outcome?: Readonly<{ code?: string; sqlState?: string }>, current = context.getStore()): void {
    if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return;
    // Successful per-query/callback timings dominate long-lived diagnostic logs.
    // Keep request summaries and failed spans at debug; full SQL span detail is trace.
    const level = phase.startsWith('db.') && status !== 'failed' ? 'trace' : 'debug';
    try {
        if (!logger.isLevelEnabled(level)) return;
        log({ level, module: 'web-latency', phase, elapsedMs,
        ...(transactionClass ? { transactionClass } : {}),
        ...(status ? { status, ...outcome } : {}),
        ...(current ? { requestId: current.requestId, ...(current.sessionId ? { sessionId: current.sessionId } : {}),
            ...(current.spanId === undefined ? {} : { spanId: current.spanId }),
            ...(current.attempt ? { attemptId: current.attempt.attemptId } : {}),
            ...(current.parentSpanId === undefined ? {} : { parentSpanId: current.parentSpanId }) } : {}),
    }, '[web-latency]'); } catch { /* Diagnostic only. */ }
}
