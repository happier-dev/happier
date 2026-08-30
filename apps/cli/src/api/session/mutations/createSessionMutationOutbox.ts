import { logger } from '@/ui/logger';
import type {
    SessionRuntimeActivityProjection,
    SessionRuntimeActivitySnapshot,
} from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { isAuthenticationError } from '@/api/client/httpStatusError';

import {
    resolveSessionMutationMaxAttempts,
    resolveSessionMutationRetryDelayMs,
    resolveSessionMutationTranscriptFlushBatchLimit,
} from './sessionMutationBackoff';
import {
    appendSessionMutationDeadLetters,
    createSessionMutationDeadLetterEntry,
    loadSessionMutationOutbox,
    parseQueuedSessionMutation,
    recoverAuthoritativeSessionMutationDeadLetters,
    resolveSessionMutationJournalPaths,
    saveSessionMutationOutbox,
    type SessionMutationJournalAdmission,
    type SessionMutationJournalCustody,
    type SessionMutationJournalPaths,
    type SessionMutationPersistenceContext,
} from './sessionMutationPersistence';
import { deliverSessionTurnMutation, type UnsupportedSessionTurnMutationDiagnostic } from './deliverSessionTurnMutation';
import {
    deliverTranscriptMessageMutation,
    deliverTranscriptMessageMutationToReleasedServerV021,
} from './deliverTranscriptMessageMutation';
import { deliverRuntimeActivitySnapshot } from './deliverRuntimeActivitySnapshot';
import {
    createDeliveryDiagnostic,
    deadLetterDependentMutations,
    shouldDeadLetterFailedMutation,
    type SessionMutationDeliveryOutcome,
} from './sessionMutationOutboxFailureHandling';
import { withSessionMutationDeliverySlot } from './sessionMutationDeliveryLimiter';
import type {
    QueuedSessionMutation,
    RuntimeActivitySnapshotMutationV1,
    SessionTurnMutationV1,
    TranscriptMessageAppendMutationV1,
} from './sessionMutationTypes';
import {
    hasSameTranscriptMessageAppendMutationProvenance,
    resolveTranscriptMessageAppendMutationId,
    validateTranscriptMessageAppendMutationProvenance,
} from './sessionMutationTypes';
import type { SessionMutationDeadLetterEntry } from './sessionMutationPersistence';
import {
    isAuthoritativeSessionMutation,
    isAuthoritativeSessionMutationKind,
} from './sessionMutationDurabilityPolicy';
import {
    supportsRuntimeActivityV2,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';

export type SessionMutationSocket = {
    connected?: boolean;
    emit: (event: string, ...args: unknown[]) => unknown;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => SessionMutationSocket;
};

export type SessionMutationEnqueueResult = Readonly<{
    persisted: boolean;
    delivered: boolean;
}>;

export class SessionMutationJournalAdmissionBlockedError extends Error {
    override readonly cause: unknown;

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'SessionMutationJournalAdmissionBlockedError';
        this.cause = cause;
    }
}

export type RuntimeActivitySnapshotTail = Readonly<{
    sequence: number;
    custody: Readonly<{
        identity: Readonly<{
            mutationKey: string;
            admissionOrder: number;
        }>;
        value: SessionRuntimeActivitySnapshot;
    }> | null;
    settlement: Readonly<{
        identity: Readonly<{
            mutationKey: string;
            admissionOrder: number;
        }>;
        desiredValue: SessionRuntimeActivitySnapshot;
        result: 'applied' | 'unchanged';
        committedProjection: SessionRuntimeActivityProjection;
        committedRevision: number;
    }> | null;
}>;

export type SessionMutationOutbox = Readonly<{
    enqueueSessionTurn(mutation: SessionTurnMutationV1): Promise<void>;
    enqueueTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueRuntimeActivitySnapshot(mutation: RuntimeActivitySnapshotMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    setSessionSyncPendingInputServerContract(
        result: SessionSyncPendingInputServerContractResult,
    ): Promise<void>;
    readRuntimeActivitySnapshotTail(): RuntimeActivitySnapshotTail;
    waitForRuntimeActivitySnapshotTailChange(sequence: number, signal?: AbortSignal): Promise<boolean>;
    awaitReady(): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

export type SessionMutationJournal = SessionMutationOutbox & Readonly<{
    enqueueSessionTurnDurably(mutation: SessionTurnMutationV1): Promise<SessionMutationEnqueueResult>;
}>;

type SessionMutationOutboxInstance = Omit<SessionMutationOutbox, 'enqueueSessionTurn'> & Readonly<{
    enqueueSessionTurn(mutation: SessionTurnMutationV1): Promise<SessionMutationEnqueueResult>;
}>;

export type CreateSessionMutationOutboxParams = Readonly<{
    token: string;
    sessionId: string;
    getSocket: () => SessionMutationSocket;
    requestReconnect: (reason: string) => void;
}>;

export type CreateSessionMutationJournalParams = Readonly<{
    custody: SessionMutationJournalCustody;
    sessionId: string;
    paths: SessionMutationJournalPaths;
    admission: SessionMutationJournalAdmission;
    token: string;
    getSocket: () => SessionMutationSocket;
    requestReconnect: (reason: string) => void;
    deliverRuntimeActivitySnapshot?: (
        mutation: RuntimeActivitySnapshotMutationV1,
    ) => Promise<SessionMutationDeliveryOutcome>;
}>;

type SessionMutationOutboxSharedEntry = Readonly<{
    outbox: SessionMutationOutboxInstance;
    handles: Map<symbol, CreateSessionMutationJournalParams>;
    sessionId: string;
    custody: SessionMutationJournalCustody;
    deadLetterPath: string;
}>;

const sharedSessionMutationOutboxes = new Map<string, SessionMutationOutboxSharedEntry>();

const loggedUnsupportedSessionTurnMutationDiagnostics = new Set<string>();

function createQueuedSessionTurn(mutation: SessionTurnMutationV1): QueuedSessionMutation {
    const now = Date.now();
    return {
        kind: 'session_turn',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function selectActiveOutboxHandle(
    handles: Map<symbol, CreateSessionMutationJournalParams>,
): CreateSessionMutationJournalParams {
    const allHandles = [...handles.values()];
    const connectedHandle = allHandles.find((handle) => {
        try {
            return handle.getSocket().connected === true;
        } catch {
            return false;
        }
    });
    return connectedHandle ?? allHandles[allHandles.length - 1];
}

export function createSessionMutationOutbox(params: CreateSessionMutationOutboxParams): SessionMutationOutbox {
    return createSessionMutationJournal({
        ...params,
        custody: 'runtime',
        paths: resolveSessionMutationJournalPaths({
            activeServerDir: configuration.activeServerDir,
            sessionId: params.sessionId,
            custody: 'runtime',
        }),
        admission: parseQueuedSessionMutation,
        deliverRuntimeActivitySnapshot: async (mutation) => await deliverRuntimeActivitySnapshot({
            socket: params.getSocket(),
            mutation,
        }),
    });
}

export function createSessionMutationJournal(params: CreateSessionMutationJournalParams): SessionMutationJournal {
    const outboxPath = params.paths.queuePath;
    let shared = sharedSessionMutationOutboxes.get(outboxPath);
    if (shared && (
        shared.sessionId !== params.sessionId
        || shared.custody !== params.custody
        || shared.deadLetterPath !== params.paths.deadLetterPath
    )) {
        throw new Error('Session mutation journal path is already owned by different custody facts');
    }
    if (!shared) {
        const handles = new Map<symbol, CreateSessionMutationJournalParams>();
        const adapterParams: CreateSessionMutationJournalParams = {
            get token() {
                return selectActiveOutboxHandle(handles).token;
            },
            sessionId: params.sessionId,
            custody: params.custody,
            paths: params.paths,
            admission: params.admission,
            deliverRuntimeActivitySnapshot: async (mutation) => {
                const candidateHandles = [...handles.values()].filter((handle) => (
                    handle.deliverRuntimeActivitySnapshot !== undefined
                ));
                const selected = candidateHandles.find((handle) => {
                    try {
                        return handle.getSocket().connected === true;
                    } catch {
                        return false;
                    }
                }) ?? candidateHandles[candidateHandles.length - 1];
                if (!selected?.deliverRuntimeActivitySnapshot) {
                    return { status: 'retryable', reason: 'runtime_activity_snapshot_delivery_unavailable' };
                }
                return await selected.deliverRuntimeActivitySnapshot(mutation);
            },
            getSocket: () => selectActiveOutboxHandle(handles).getSocket(),
            requestReconnect: (reason) => {
                for (const handle of handles.values()) {
                    try {
                        handle.requestReconnect(reason);
                    } catch (error) {
                        logger.debug('[API] Durable session mutation reconnect request failed', {
                            sessionId: params.sessionId,
                            error: serializeAxiosErrorForLog(error),
                        });
                    }
                }
            },
        };
        shared = {
            handles,
            outbox: createSessionMutationOutboxInstance(adapterParams),
            sessionId: params.sessionId,
            custody: params.custody,
            deadLetterPath: params.paths.deadLetterPath,
        };
        sharedSessionMutationOutboxes.set(outboxPath, shared);
    }

    const handleId = Symbol(params.sessionId);
    let handleClosed = false;
    const sharedEntry = shared;
    sharedEntry.handles.set(handleId, params);
    const closeHandle = async () => {
        if (handleClosed) return;
        handleClosed = true;
        const current = sharedSessionMutationOutboxes.get(outboxPath);
        if (!current) return;
        if (current.handles.size === 1 && current.handles.has(handleId)) {
            sharedSessionMutationOutboxes.delete(outboxPath);
            try {
                await current.outbox.close();
            } finally {
                current.handles.delete(handleId);
            }
            return;
        }
        current.handles.delete(handleId);
        if (current.handles.size > 0) return;
        sharedSessionMutationOutboxes.delete(outboxPath);
        await current.outbox.close();
    };
    const enqueueIfOpen = async <T>(enqueue: () => Promise<T>, fallback: T): Promise<T> => {
        if (handleClosed) return fallback;
        return await enqueue();
    };

    return {
        enqueueSessionTurn: async (mutation) => {
            await enqueueIfOpen(
                () => sharedEntry.outbox.enqueueSessionTurn(mutation),
                { persisted: false, delivered: false },
            );
        },
        enqueueSessionTurnDurably: async (mutation) => await enqueueIfOpen(
            () => sharedEntry.outbox.enqueueSessionTurn(mutation),
            { persisted: false, delivered: false },
        ),
        enqueueTranscriptMessage: async (mutation) => await enqueueIfOpen(
            () => sharedEntry.outbox.enqueueTranscriptMessage(mutation),
            { persisted: false, delivered: false },
        ),
        enqueueRuntimeActivitySnapshot: async (mutation) => await enqueueIfOpen(
            () => sharedEntry.outbox.enqueueRuntimeActivitySnapshot(mutation),
            { persisted: false, delivered: false },
        ),
        setSessionSyncPendingInputServerContract: async (result) => {
            if (handleClosed) return;
            await sharedEntry.outbox.setSessionSyncPendingInputServerContract(result);
        },
        readRuntimeActivitySnapshotTail: () => sharedEntry.outbox.readRuntimeActivitySnapshotTail(),
        waitForRuntimeActivitySnapshotTailChange: async (sequence, signal) => {
            if (handleClosed) return false;
            return await sharedEntry.outbox.waitForRuntimeActivitySnapshotTailChange(sequence, signal);
        },
        awaitReady: async () => {
            if (handleClosed) return;
            await sharedEntry.outbox.awaitReady();
        },
        flush: async (reason) => {
            if (handleClosed) return;
            await sharedEntry.outbox.flush(reason);
        },
        close: closeHandle,
    };
}

function createQueuedTranscriptMessage(
    mutation: TranscriptMessageAppendMutationV1,
    intentOrder: number,
): QueuedSessionMutation {
    validateTranscriptMessageAppendMutationProvenance({
        sessionId: mutation.sessionId,
        provenance: mutation.provenance,
    });
    const now = Date.now();
    const canonicalMutationId = resolveTranscriptMessageAppendMutationId({
        sessionId: mutation.sessionId,
        localId: mutation.localId,
    });
    if (mutation.mutationId !== canonicalMutationId) {
        throw new Error('Transcript append mutation id must match the canonical session/localId key');
    }
    return {
        kind: 'transcript_message_append',
        mutationId: canonicalMutationId,
        payload: mutation,
        intentOrder,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedRuntimeActivitySnapshot(
    mutation: RuntimeActivitySnapshotMutationV1,
    admissionOrder: number,
): QueuedSessionMutation {
    return {
        kind: 'runtime_activity_snapshot',
        mutationId: mutation.mutationId,
        payload: mutation,
        admissionOrder,
        createdAt: Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function readTranscriptSidechain(mutation: QueuedSessionMutation): string | null | undefined {
    if (mutation.kind !== 'transcript_message_append') return undefined;
    return mutation.payload.sidechainId ?? null;
}

function readTranscriptCoalesceKey(mutation: QueuedSessionMutation): string | null {
    if (mutation.kind !== 'transcript_message_append') return null;
    return resolveTranscriptMessageAppendMutationId({
        sessionId: mutation.payload.sessionId,
        localId: mutation.payload.localId,
    });
}

function readQueuedMutationCoalesceKey(mutation: QueuedSessionMutation): string | null {
    const transcriptKey = readTranscriptCoalesceKey(mutation);
    if (transcriptKey) return transcriptKey;
    if (mutation.kind === 'runtime_activity_snapshot') {
        return mutation.mutationId;
    }
    return null;
}

function readTranscriptUpdatedAt(mutation: QueuedSessionMutation): number {
    if (mutation.kind !== 'transcript_message_append') return Number.NEGATIVE_INFINITY;
    return Number.isFinite(mutation.payload.updatedAt) ? mutation.payload.updatedAt : mutation.createdAt;
}

function readTranscriptIntentOrder(mutation: QueuedSessionMutation): number | null {
    if (mutation.kind !== 'transcript_message_append') return null;
    return typeof mutation.intentOrder === 'number'
        && Number.isSafeInteger(mutation.intentOrder)
        && mutation.intentOrder > 0
        ? mutation.intentOrder
        : null;
}

function shouldReplaceCoalescedMutation(existing: QueuedSessionMutation, next: QueuedSessionMutation): boolean {
    if (existing.kind === 'session_turn' && next.kind === 'session_turn') {
        // A turn mutation id identifies one immutable observation. Marker replay may
        // reconstruct the same deterministic id after the row was persisted; retain
        // the first accepted payload instead of silently changing its receipt identity.
        return false;
    }
    if (existing.kind === 'transcript_message_append' && next.kind === 'transcript_message_append') {
        const existingIntentOrder = readTranscriptIntentOrder(existing);
        const nextIntentOrder = readTranscriptIntentOrder(next);
        if (nextIntentOrder !== null) {
            return existingIntentOrder === null || nextIntentOrder >= existingIntentOrder;
        }
        if (existingIntentOrder !== null) return false;
        return readTranscriptUpdatedAt(next) >= readTranscriptUpdatedAt(existing);
    }
    if (existing.kind === 'runtime_activity_snapshot' && next.kind === 'runtime_activity_snapshot') {
        return next.admissionOrder > existing.admissionOrder;
    }
    return true;
}

function assertTranscriptCoalescingCompatible(
    mutation: QueuedSessionMutation,
    queued: readonly QueuedSessionMutation[],
): void {
    if (mutation.kind !== 'transcript_message_append') return;
    const nextCoalesceKey = readTranscriptCoalesceKey(mutation);
    const nextSidechainId = readTranscriptSidechain(mutation);
    const existing = queued.find((candidate) => (
        readTranscriptCoalesceKey(candidate) === nextCoalesceKey
        && candidate.kind === 'transcript_message_append'
    ));
    if (!existing || existing.kind !== 'transcript_message_append') return;
    if (readTranscriptSidechain(existing) !== nextSidechainId) {
        throw new Error('Cannot coalesce transcript snapshot with reused localId across different sidechains');
    }
    if (!hasSameTranscriptMessageAppendMutationProvenance(existing.payload, mutation.payload)) {
        throw new Error('Cannot coalesce transcript snapshot across different causal provenance');
    }
}

function resolveUnsupportedDiagnosticKey(diagnostic: UnsupportedSessionTurnMutationDiagnostic): string {
    return [
        diagnostic.serverOrigin,
        diagnostic.sessionId,
        diagnostic.socket.transport,
        diagnostic.socket.evidence,
        diagnostic.http.transport,
        diagnostic.http.evidence,
        diagnostic.http.status,
    ].join(':');
}

function logUnsupportedSessionTurnMutationDiagnostic(diagnostic: UnsupportedSessionTurnMutationDiagnostic): void {
    const key = resolveUnsupportedDiagnosticKey(diagnostic);
    if (loggedUnsupportedSessionTurnMutationDiagnostics.has(key)) return;
    loggedUnsupportedSessionTurnMutationDiagnostics.add(key);
    logger.debug('[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued', diagnostic);
}

function mergeQueuedSessionMutations(
    earlier: readonly QueuedSessionMutation[],
    later: readonly QueuedSessionMutation[],
): QueuedSessionMutation[] {
    const merged = [...earlier];
    for (const mutation of later) {
        const mutationCoalesceKey = readQueuedMutationCoalesceKey(mutation);
        const existingIndex = merged.findIndex((queued) => (
            mutationCoalesceKey
                ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                : queued.mutationId === mutation.mutationId
        ));
        if (existingIndex >= 0) {
            if (shouldReplaceCoalescedMutation(merged[existingIndex], mutation)) {
                merged[existingIndex] = mutation;
            }
        } else {
            merged.push(mutation);
        }
    }
    return merged;
}

function runtimeActivitySnapshotsEqual(
    left: SessionRuntimeActivitySnapshot,
    right: SessionRuntimeActivitySnapshot,
): boolean {
    return left.state === right.state
        && left.activeCount === right.activeCount;
}

function createSessionMutationOutboxInstance(params: CreateSessionMutationJournalParams): SessionMutationOutboxInstance {
    const persistenceContext: SessionMutationPersistenceContext = {
        custody: params.custody,
        sessionId: params.sessionId,
        paths: params.paths,
        parseQueuedMutation: params.admission,
    };
    let closed = false;
    let mutations: QueuedSessionMutation[] = [];
    let inFlightBatch: {
        batch: readonly QueuedSessionMutation[];
        remaining: readonly QueuedSessionMutation[];
        nextIndex: number;
    } | null = null;
    let flushInFlight: Promise<void> | null = null;
    let persistTail: Promise<void> = Promise.resolve();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let loadedMutationsNeedPersist = false;
    // Set only when already-observed transcript output remains resident after its admission save failed.
    let mutationsNeedPersistBeforeDelivery = false;
    let deadLetterRecoveryTail: Promise<void> = Promise.resolve();
    let pendingEnqueuePersistenceCount = 0;
    const pendingEnqueuePersistenceWaiters = new Set<() => void>();
    let nextTranscriptIntentOrder = 1;
    let nextRuntimeActivityAdmissionOrder: number | null = 1;
    let runtimeActivityAdmissionTail: Promise<void> = Promise.resolve();
    let runtimeActivitySnapshotInitialized = false;
    let sessionSyncPendingInputServerContract: SessionSyncPendingInputServerContractResult | null = null;
    let runtimeActivityTail: RuntimeActivitySnapshotTail = {
        sequence: 0,
        custody: null,
        settlement: null,
    };
    const runtimeActivityTailWaiters = new Set<() => void>();
    const reportedPersistentlyBlockingMutationIds = new Set<string>();

    function reportPersistentlyBlockingMutation(params: Readonly<{
        mutation: QueuedSessionMutation;
        blockedMutations: readonly QueuedSessionMutation[];
        diagnostic: Readonly<Record<string, unknown>>;
    }>): void {
        if (!isAuthoritativeSessionMutation(params.mutation)) return;
        if (params.blockedMutations.length === 0) return;
        if (params.mutation.attempts < resolveSessionMutationMaxAttempts()) return;
        if (reportedPersistentlyBlockingMutationIds.has(params.mutation.mutationId)) return;
        reportedPersistentlyBlockingMutationIds.add(params.mutation.mutationId);

        const blockedMutationKinds: Record<string, number> = {};
        for (const blocked of params.blockedMutations) {
            blockedMutationKinds[blocked.kind] = (blockedMutationKinds[blocked.kind] ?? 0) + 1;
        }
        const turn = params.mutation.kind === 'session_turn' ? params.mutation.payload : null;
        logger.infoFile(
            '[API] Authoritative session mutation remains queued and is blocking later mutations',
            {
                sessionId: params.mutation.payload.sessionId,
                mutationId: params.mutation.mutationId,
                mutationKind: params.mutation.kind,
                attempts: params.mutation.attempts,
                ageMs: Math.max(0, Date.now() - params.mutation.createdAt),
                ...(turn ? {
                    action: turn.action,
                    ...(turn.turnId ? { turnId: turn.turnId } : {}),
                    ...(turn.provider ? { provider: turn.provider } : {}),
                } : {}),
                ...params.diagnostic,
                blockedMutationCount: params.blockedMutations.length,
                blockedMutationKinds,
                serverContractMode: sessionSyncPendingInputServerContract?.mode ?? 'unknown',
                runtimeActivityServerContract: sessionSyncPendingInputServerContract?.runtimeActivity ?? 'unknown',
                pendingInputServerContract: sessionSyncPendingInputServerContract?.pendingInput ?? 'unknown',
            },
        );
    }

    function publishRuntimeActivityTail(next: Omit<RuntimeActivitySnapshotTail, 'sequence'>): void {
        runtimeActivityTail = {
            sequence: Math.min(Number.MAX_SAFE_INTEGER, runtimeActivityTail.sequence + 1),
            ...next,
        };
        for (const resolve of runtimeActivityTailWaiters) resolve();
        runtimeActivityTailWaiters.clear();
    }

    function readInFlightMutations(): QueuedSessionMutation[] {
        if (!inFlightBatch) return [];
        return mergeQueuedSessionMutations(
            inFlightBatch.remaining,
            inFlightBatch.batch.slice(inFlightBatch.nextIndex),
        );
    }

    function advanceInFlightBatch(nextIndex: number): void {
        if (!inFlightBatch) return;
        inFlightBatch.nextIndex = nextIndex;
    }
    async function recoverDeadLetteredAuthoritativeMutations(): Promise<void> {
        const recover = async () => {
            const recovered = await recoverAuthoritativeSessionMutationDeadLetters(
                persistenceContext,
                async (candidateMutations) => {
                    const previousMutations = mutations;
                    mutations = mergeQueuedSessionMutations(mutations, candidateMutations);
                    try {
                        await persist();
                    } catch (error) {
                        mutations = previousMutations;
                        throw error;
                    }
                },
            );
            if (recovered.length === 0) return;
            logger.debug('[API] Re-queued authoritative session mutations from dead letters', {
                sessionId: params.sessionId,
                recoveredCount: recovered.length,
            });
        };
        const recoveryPromise = deadLetterRecoveryTail.then(recover, recover);
        deadLetterRecoveryTail = recoveryPromise.catch(() => {});
        await recoveryPromise;
    }

    let quarantinedLoadedMutationCount = 0;
    const loaded = loadSessionMutationOutbox(
        persistenceContext,
        (count) => { quarantinedLoadedMutationCount += count; },
    )
        .then(async (loaded) => {
            mutations = mergeQueuedSessionMutations([], loaded);
            const highestPersistedIntentOrder = mutations.reduce((highest, mutation) => (
                Math.max(highest, readTranscriptIntentOrder(mutation) ?? 0)
            ), 0);
            nextTranscriptIntentOrder = Math.min(Number.MAX_SAFE_INTEGER, highestPersistedIntentOrder + 1);
            const queuedRuntimeActivity = mutations.find((mutation) => mutation.kind === 'runtime_activity_snapshot');
            const highestRuntimeActivityAdmissionOrder = mutations.reduce((highest, mutation) => (
                mutation.kind === 'runtime_activity_snapshot'
                    ? Math.max(highest, mutation.admissionOrder)
                    : highest
            ), 0);
            nextRuntimeActivityAdmissionOrder = highestRuntimeActivityAdmissionOrder >= Number.MAX_SAFE_INTEGER
                ? null
                : highestRuntimeActivityAdmissionOrder + 1;
            if (queuedRuntimeActivity?.kind === 'runtime_activity_snapshot') {
                runtimeActivityTail = {
                    sequence: 1,
                    custody: {
                        identity: {
                            mutationKey: queuedRuntimeActivity.mutationId,
                            admissionOrder: queuedRuntimeActivity.admissionOrder,
                        },
                        value: queuedRuntimeActivity.payload.snapshot,
                    },
                    settlement: null,
                };
            }
            loadedMutationsNeedPersist = quarantinedLoadedMutationCount > 0
                || mutations.length !== loaded.length;
            if (loadedMutationsNeedPersist) {
                await persist();
                loadedMutationsNeedPersist = false;
            }
            await recoverDeadLetteredAuthoritativeMutations();
        })
        .catch((error) => {
            logger.debug('[API] Failed to load durable session mutation outbox', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
            throw error;
        });

    async function persist(): Promise<void> {
        const runPersist = async () => {
            await saveSessionMutationOutbox(
                persistenceContext,
                mergeQueuedSessionMutations(readInFlightMutations(), mutations),
            );
        };
        const persistPromise = persistTail.then(runPersist, runPersist);
        persistTail = persistPromise.catch(() => {});
        await persistPromise;
    }

    const ready = loaded;

    async function waitForPendingEnqueuePersistence(): Promise<void> {
        while (pendingEnqueuePersistenceCount > 0) {
            await new Promise<void>((resolve) => pendingEnqueuePersistenceWaiters.add(resolve));
        }
    }

    function finishPendingEnqueuePersistence(): void {
        pendingEnqueuePersistenceCount -= 1;
        if (pendingEnqueuePersistenceCount !== 0) return;
        for (const resolve of pendingEnqueuePersistenceWaiters) resolve();
        pendingEnqueuePersistenceWaiters.clear();
    }

    function clearRetryTimer(): void {
        if (!retryTimer) return;
        clearTimeout(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry(minimumDelayMs = 0): void {
        if (closed || retryTimer || mutations.length === 0) return;
        const now = Date.now();
        const nextAttemptAt = Math.min(...mutations.map((mutation) => mutation.nextAttemptAt || now));
        const delayMs = Math.max(minimumDelayMs, 0, nextAttemptAt - now);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void flush('timer').catch((error) => {
                logger.debug('[API] Durable session mutation retry flush failed', {
                    sessionId: params.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }, delayMs);
        retryTimer.unref?.();
    }

    async function deliver(mutation: QueuedSessionMutation): Promise<SessionMutationDeliveryOutcome> {
        if (mutation.kind === 'session_turn') {
            const result = await deliverSessionTurnMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
            if (result.status === 'unsupported_capability') {
                logUnsupportedSessionTurnMutationDiagnostic(result.diagnostic);
            }
            return result;
        }
        if (mutation.kind === 'transcript_message_append') {
            if (sessionSyncPendingInputServerContract?.pendingInput === 'released_server_v0_2_1') {
                return await deliverTranscriptMessageMutationToReleasedServerV021({
                    socket: params.getSocket(),
                    mutation: mutation.payload,
                });
            }
            return await deliverTranscriptMessageMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
        }
        if (mutation.kind === 'runtime_activity_snapshot') {
            if (!params.deliverRuntimeActivitySnapshot) {
                return { status: 'retryable', reason: 'runtime_activity_snapshot_delivery_unavailable' };
            }
            return await params.deliverRuntimeActivitySnapshot(mutation.payload);
        }
        return { status: 'permanent_invalid_payload', reason: 'unsupported_session_mutation_kind' };
    }

    async function flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void> {
        await ready;
        // Enqueue mutates the in-memory queue before persisting it. A startup,
        // reconnect, or timer flush can race that write, so never expose the
        // candidate queue to delivery until every in-flight admission has
        // either committed or restored the prior durable queue shape.
        await waitForPendingEnqueuePersistence();
        await recoverDeadLetteredAuthoritativeMutations().catch((error) => {
            logger.debug('[API] Failed to recover dead-lettered authoritative session mutations', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        // Dead-letter inspection is asynchronous, so a new enqueue may begin
        // after the first custody barrier. Close that window before the queue
        // is captured for delivery.
        await waitForPendingEnqueuePersistence();
        if (closed && reason !== 'flush') return;
        if (flushInFlight) {
            await flushInFlight;
            if (reason !== 'timer') {
                await flush(reason);
            }
            return;
        }
        flushInFlight = (async () => {
            clearRetryTimer();
            if (mutationsNeedPersistBeforeDelivery) {
                await persist();
                mutationsNeedPersistBeforeDelivery = false;
            }
            const now = Date.now();
            let didChange = loadedMutationsNeedPersist;
            loadedMutationsNeedPersist = false;
            let shouldRequestReconnect = false;
            let runtimeActivitySettlementAfterPersist: RuntimeActivitySnapshotTail['settlement'] = null;
            let runtimeActivityRetirementAfterPersist: number | null = null;
            const remaining: QueuedSessionMutation[] = [];
            const batch = mutations;
            mutations = [];
            inFlightBatch = { batch, remaining, nextIndex: 0 };
            const deadLetters: SessionMutationDeadLetterEntry[] = [];
            const transcriptFlushBatchLimit = reason === 'flush'
                ? Number.POSITIVE_INFINITY
                : resolveSessionMutationTranscriptFlushBatchLimit();
            let transcriptDeliveriesThisFlush = 0;
            // Runtime activity is an independent projection. Preserve ordering for blocked
            // session-turn/transcript mutations, but still allow a later activity snapshot to
            // clear stale background activity.
            let earlierAuthoritativeMutationBlocked = false;
            const refreshInFlightMutations = (nextIndex: number) => {
                advanceInFlightBatch(nextIndex);
            };
            for (let index = 0; index < batch.length; index += 1) {
                const mutation = batch[index];
                if (mutation.kind === 'runtime_activity_snapshot') {
                    if (!supportsRuntimeActivityV2(sessionSyncPendingInputServerContract)) {
                        if (sessionSyncPendingInputServerContract?.runtimeActivity === 'legacy') {
                            didChange = true;
                            runtimeActivityRetirementAfterPersist = mutation.admissionOrder;
                            refreshInFlightMutations(index + 1);
                            continue;
                        }
                        remaining.push(mutation);
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                }
                if (mutation.kind === 'runtime_activity_snapshot' && !runtimeActivitySnapshotInitialized) {
                    remaining.push(mutation);
                    refreshInFlightMutations(index + 1);
                    continue;
                }
                if (earlierAuthoritativeMutationBlocked && mutation.kind !== 'runtime_activity_snapshot') {
                    remaining.push(mutation);
                    refreshInFlightMutations(index + 1);
                    continue;
                }
                const shouldRedriveAuthoritative = (
                    (reason === 'connect' || reason === 'startup')
                    && isAuthoritativeSessionMutationKind(mutation.kind)
                );
                if (!shouldRedriveAuthoritative && reason !== 'flush' && mutation.nextAttemptAt > now) {
                    if (mutation.kind === 'runtime_activity_snapshot') {
                        remaining.push(mutation);
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                    remaining.push(mutation);
                    earlierAuthoritativeMutationBlocked = true;
                    refreshInFlightMutations(index + 1);
                    continue;
                }
                const parsedMutation = params.admission(mutation, params.sessionId);
                if (!parsedMutation.ok) {
                    deadLetters.push(parsedMutation.deadLetter);
                    const nextIndex = deadLetterDependentMutations({
                        batch,
                        startIndex: index + 1,
                        failedMutation: mutation,
                        deadLetters,
                    });
                    refreshInFlightMutations(nextIndex);
                    index = nextIndex - 1;
                    didChange = true;
                    continue;
                }
                if (
                    reason !== 'flush'
                    && mutation.kind === 'transcript_message_append'
                    && transcriptDeliveriesThisFlush >= transcriptFlushBatchLimit
                ) {
                    remaining.push({
                        ...mutation,
                        nextAttemptAt: Math.max(
                            mutation.nextAttemptAt,
                            Date.now() + resolveSessionMutationRetryDelayMs(0),
                        ),
                    } as QueuedSessionMutation);
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
                }
                if (mutation.kind === 'transcript_message_append') {
                    transcriptDeliveriesThisFlush += 1;
                }
                try {
                    const outcome = await withSessionMutationDeliverySlot(() => deliver(mutation));
                    if (outcome.status === 'delivered' || outcome.status === 'ignored_lossy') {
                        const exactSettlement = mutation.kind === 'runtime_activity_snapshot'
                            && outcome.status === 'delivered'
                            && outcome.runtimeActivityEvidence
                            ? {
                                identity: {
                                    mutationKey: mutation.mutationId,
                                    admissionOrder: mutation.admissionOrder,
                                },
                                desiredValue: mutation.payload.snapshot,
                                result: outcome.runtimeActivityEvidence.disposition,
                                committedProjection: outcome.runtimeActivityEvidence.projection,
                                committedRevision: outcome.runtimeActivityEvidence.projection.revision,
                            }
                            : null;
                        didChange = true;
                        refreshInFlightMutations(index + 1);
                        if (exactSettlement) {
                            // The durable dequeue save below is the commit point for exact evidence.
                            runtimeActivitySettlementAfterPersist = exactSettlement;
                        }
                        continue;
                    }
                    const attempts = mutation.attempts + 1;
                    const failedMutation = {
                        ...mutation,
                        attempts,
                        nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(attempts),
                    } as QueuedSessionMutation;
                    if (mutation.kind === 'runtime_activity_snapshot') {
                        remaining.push(failedMutation);
                        refreshInFlightMutations(index + 1);
                        didChange = true;
                        continue;
                    }
                    if (shouldDeadLetterFailedMutation(failedMutation, Date.now(), outcome)) {
                        deadLetters.push(createSessionMutationDeadLetterEntry({
                            sessionId: params.sessionId,
                            mutation: failedMutation,
                            reason: outcome.status === 'permanent_invalid_payload'
                                ? 'permanent_invalid_payload'
                                : 'retry_exhausted',
                            diagnostic: createDeliveryDiagnostic(outcome),
                        }));
                        const nextIndex = deadLetterDependentMutations({
                            batch,
                            startIndex: index + 1,
                            failedMutation,
                            deadLetters,
                        });
                        refreshInFlightMutations(nextIndex);
                        index = nextIndex - 1;
                        didChange = true;
                        continue;
                    }
                    reportPersistentlyBlockingMutation({
                        mutation: failedMutation,
                        blockedMutations: batch.slice(index + 1),
                        diagnostic: createDeliveryDiagnostic(outcome),
                    });
                    remaining.push(failedMutation);
                    earlierAuthoritativeMutationBlocked = true;
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    shouldRequestReconnect = true;
                    continue;
                } catch (error) {
                    if (isAuthenticationError(error)) {
                        remaining.push({
                            ...mutation,
                            nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(mutation.attempts + 1),
                        } as QueuedSessionMutation);
                        remaining.push(...batch.slice(index + 1));
                        inFlightBatch = null;
                        didChange = true;
                        break;
                    }
                    logger.debug('[API] Durable session mutation delivery failed', {
                        sessionId: params.sessionId,
                        mutationKind: mutation.kind,
                        mutationId: mutation.mutationId,
                        error: serializeAxiosErrorForLog(error),
                    });
                }

                const attempts = mutation.attempts + 1;
                const failedMutation = {
                    ...mutation,
                    attempts,
                    nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(attempts),
                } as QueuedSessionMutation;
                if (shouldDeadLetterFailedMutation(failedMutation, Date.now())) {
                    deadLetters.push(createSessionMutationDeadLetterEntry({
                        sessionId: params.sessionId,
                        mutation: failedMutation,
                        reason: 'retry_exhausted',
                        diagnostic: {
                            deliveryStatus: 'retryable',
                            reason: 'delivery_exception',
                        },
                    }));
                    const nextIndex = deadLetterDependentMutations({
                        batch,
                        startIndex: index + 1,
                        failedMutation,
                        deadLetters,
                    });
                    refreshInFlightMutations(nextIndex);
                    index = nextIndex - 1;
                    didChange = true;
                    continue;
                }
                reportPersistentlyBlockingMutation({
                    mutation: failedMutation,
                    blockedMutations: batch.slice(index + 1),
                    diagnostic: {
                        deliveryStatus: 'retryable',
                        reason: 'delivery_exception',
                    },
                });
                remaining.push(failedMutation);
                earlierAuthoritativeMutationBlocked = true;
                refreshInFlightMutations(index + 1);
                didChange = true;
                shouldRequestReconnect = true;
                continue;
            }
            mutations = mergeQueuedSessionMutations(remaining, mutations);
            inFlightBatch = null;
            if (didChange) {
                try {
                    await appendSessionMutationDeadLetters(persistenceContext, deadLetters);
                    await persist();
                } catch (error) {
                    // Delivery success is not a dequeue until the resulting queue has
                    // durably committed. Restore the attempted batch in process so a
                    // retry can rejoin the server result (normally as unchanged).
                    mutations = mergeQueuedSessionMutations(batch, mutations);
                    scheduleRetry(resolveSessionMutationRetryDelayMs(1));
                    throw error;
                }
            }
            if (
                runtimeActivitySettlementAfterPersist
                && runtimeActivityTail.custody?.identity.admissionOrder
                    === runtimeActivitySettlementAfterPersist.identity.admissionOrder
            ) {
                publishRuntimeActivityTail({
                    custody: null,
                    settlement: runtimeActivitySettlementAfterPersist,
                });
            } else if (
                runtimeActivityRetirementAfterPersist !== null
                && runtimeActivityTail.custody?.identity.admissionOrder === runtimeActivityRetirementAfterPersist
            ) {
                publishRuntimeActivityTail({ custody: null, settlement: null });
            }
            const hasDeliverableMutation = mutations.some((mutation) => (
                mutation.kind !== 'runtime_activity_snapshot'
                || (
                    runtimeActivitySnapshotInitialized
                    && supportsRuntimeActivityV2(sessionSyncPendingInputServerContract)
                )
            ));
            if (!closed && hasDeliverableMutation) {
                if (shouldRequestReconnect) {
                    params.requestReconnect(reason);
                }
                scheduleRetry();
            }
        })().finally(() => {
            flushInFlight = null;
        });
        await flushInFlight;
    }

    function hasQueuedMutation(mutationId: string): boolean {
        return (
            mutations.some((queued) => queued.mutationId === mutationId)
            || readInFlightMutations().some((queued) => queued.mutationId === mutationId)
        );
    }

    async function enqueue(
        mutation: QueuedSessionMutation,
        opts: Readonly<{
            awaitFlush?: boolean;
            initializesRuntimeActivitySnapshot?: boolean;
            onPersisted?: () => void;
        }> = {},
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        await ready;
        if (closed) return { persisted: false, delivered: false };
        assertTranscriptCoalescingCompatible(mutation, mutations);
        assertTranscriptCoalescingCompatible(mutation, readInFlightMutations());
        pendingEnqueuePersistenceCount += 1;
        const wasRuntimeActivitySnapshotInitialized = runtimeActivitySnapshotInitialized;
        const isInitialRuntimeActivitySnapshot = opts.initializesRuntimeActivitySnapshot === true
            && !wasRuntimeActivitySnapshotInitialized;
        if (opts.initializesRuntimeActivitySnapshot === true) {
            runtimeActivitySnapshotInitialized = true;
        }
        const mutationCoalesceKey = readQueuedMutationCoalesceKey(mutation);
        const existingIndex = mutations.findIndex((queued) => (
            mutationCoalesceKey
                ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                : queued.mutationId === mutation.mutationId
        ));
        const previousMutation = existingIndex >= 0 ? mutations[existingIndex] : null;
        let didChangeQueue = false;
        if (existingIndex >= 0) {
            if (shouldReplaceCoalescedMutation(mutations[existingIndex], mutation)) {
                if (isInitialRuntimeActivitySnapshot) {
                    mutations.splice(existingIndex, 1);
                    mutations.unshift(mutation);
                } else {
                    mutations[existingIndex] = mutation;
                }
                didChangeQueue = true;
            }
        } else {
            if (isInitialRuntimeActivitySnapshot) mutations.unshift(mutation);
            else mutations.push(mutation);
            didChangeQueue = true;
        }
        try {
            await persist();
            mutationsNeedPersistBeforeDelivery = false;
        } catch (error) {
            runtimeActivitySnapshotInitialized = wasRuntimeActivitySnapshotInitialized;
            // Transcript mutations describe provider output that has already been
            // observed. When storage is temporarily unavailable, retain that
            // candidate in the canonical in-process journal so an explicit or
            // lifecycle flush can persist it after recovery. Pre-effect admission
            // mutations still roll back and fail closed before provider dispatch.
            if (didChangeQueue && mutation.kind !== 'transcript_message_append') {
                const candidateIndex = mutations.findIndex((queued) => (
                    mutationCoalesceKey
                        ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                        : queued.mutationId === mutation.mutationId
                ));
                if (candidateIndex >= 0 && mutations[candidateIndex] === mutation) {
                    if (previousMutation && isInitialRuntimeActivitySnapshot) {
                        mutations.splice(candidateIndex, 1);
                        mutations.splice(Math.min(existingIndex, mutations.length), 0, previousMutation);
                    } else if (previousMutation) {
                        mutations[candidateIndex] = previousMutation;
                    } else {
                        mutations.splice(candidateIndex, 1);
                    }
                }
            } else if (didChangeQueue) {
                mutationsNeedPersistBeforeDelivery = true;
            }
            throw new SessionMutationJournalAdmissionBlockedError(error);
        } finally {
            finishPendingEnqueuePersistence();
        }
        opts.onPersisted?.();
        const flushPromise = flush('enqueue').catch((error) => {
            logger.debug('[API] Durable session mutation enqueue flush failed', {
                sessionId: params.sessionId,
                mutationKind: mutation.kind,
                mutationId: mutation.mutationId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        if (opts.awaitFlush === true) {
            await flushPromise;
        } else {
            void flushPromise;
        }
        return { persisted: true, delivered: !hasQueuedMutation(mutation.mutationId) };
    }

    void ready.then(() => flush('startup')).catch((error) => {
        logger.debug('[API] Durable session mutation startup flush failed', {
            sessionId: params.sessionId,
            error: serializeAxiosErrorForLog(error),
        });
    });

    return {
        async enqueueSessionTurn(mutation) {
            return await enqueue(createQueuedSessionTurn(mutation), {
                awaitFlush: mutation.action === 'fail' || mutation.action === 'cancel',
            });
        },
        async enqueueTranscriptMessage(mutation) {
            if (mutation.sessionId !== params.sessionId) {
                throw new Error('Transcript append mutation sessionId must match outbox sessionId');
            }
            const intentOrder = nextTranscriptIntentOrder;
            nextTranscriptIntentOrder = Math.min(Number.MAX_SAFE_INTEGER, nextTranscriptIntentOrder + 1);
            const result = await enqueue(createQueuedTranscriptMessage(mutation, intentOrder), { awaitFlush: true });
            return { persisted: result.persisted, delivered: result.delivered };
        },
        async enqueueRuntimeActivitySnapshot(mutation) {
            const previousAdmission = runtimeActivityAdmissionTail;
            let releaseAdmission!: () => void;
            const currentAdmission = new Promise<void>((resolve) => {
                releaseAdmission = resolve;
            });
            runtimeActivityAdmissionTail = previousAdmission.then(
                () => currentAdmission,
                () => currentAdmission,
            );
            await previousAdmission;
            try {
                const currentCustody = runtimeActivityTail.custody;
                if (
                    currentCustody?.identity.mutationKey === mutation.mutationId
                    && runtimeActivitySnapshotsEqual(currentCustody.value, mutation.snapshot)
                ) {
                    if (!runtimeActivitySnapshotInitialized) {
                        runtimeActivitySnapshotInitialized = true;
                        releaseAdmission();
                        await flush('flush').catch((error) => {
                            logger.debug('[API] Hydrated Runtime Activity custody activation flush failed', {
                                sessionId: params.sessionId,
                                mutationId: mutation.mutationId,
                                error: serializeAxiosErrorForLog(error),
                            });
                        });
                    }
                    return {
                        persisted: true,
                        delivered: !hasQueuedMutation(mutation.mutationId),
                    };
                }
                const admissionOrder = nextRuntimeActivityAdmissionOrder;
                if (admissionOrder === null) {
                    throw new RangeError('Runtime Activity admission order exhausted');
                }
                const queued = createQueuedRuntimeActivitySnapshot(mutation, admissionOrder);
                const result = await enqueue(queued, {
                    awaitFlush: true,
                    initializesRuntimeActivitySnapshot: true,
                    onPersisted: () => {
                        nextRuntimeActivityAdmissionOrder = admissionOrder >= Number.MAX_SAFE_INTEGER
                            ? null
                            : admissionOrder + 1;
                        publishRuntimeActivityTail({
                            custody: {
                                identity: {
                                    mutationKey: queued.mutationId,
                                    admissionOrder,
                                },
                                value: mutation.snapshot,
                            },
                            settlement: null,
                        });
                        releaseAdmission();
                    },
                });
                return result;
            } finally {
                releaseAdmission();
            }
        },
        async setSessionSyncPendingInputServerContract(result) {
            await ready;
            if (closed || sessionSyncPendingInputServerContract === result) return;
            const previousRuntimeActivity = sessionSyncPendingInputServerContract?.runtimeActivity;
            sessionSyncPendingInputServerContract = result;
            if (result.runtimeActivity === 'legacy' && previousRuntimeActivity !== 'legacy') await flush('flush');
        },
        readRuntimeActivitySnapshotTail() {
            return runtimeActivityTail;
        },
        async waitForRuntimeActivitySnapshotTailChange(sequence, signal) {
            if (!Number.isSafeInteger(sequence) || sequence < 0) return true;
            if (runtimeActivityTail.sequence !== sequence) return true;
            if (signal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                let settled = false;
                const finish = (changed: boolean) => {
                    if (settled) return;
                    settled = true;
                    runtimeActivityTailWaiters.delete(onChanged);
                    signal?.removeEventListener('abort', onAbort);
                    resolve(changed);
                };
                const onChanged = () => finish(true);
                const onAbort = () => finish(false);
                runtimeActivityTailWaiters.add(onChanged);
                signal?.addEventListener('abort', onAbort, { once: true });
                if (runtimeActivityTail.sequence !== sequence) finish(true);
            });
        },
        async awaitReady() {
            await ready;
        },
        flush,
        async close() {
            closed = true;
            clearRetryTimer();
            await ready;
            await flush('flush');
            clearRetryTimer();
            await persist();
        },
    };
}
