import { logger } from '@/ui/logger';
import { isAuthenticationError, readAuthenticationStatus } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

import {
    resolveSessionClientDurableMutationMaxAttempts,
    resolveSessionClientDurableMutationRetryDelayMs,
    resolveSessionClientDurableMutationTranscriptFlushBatchLimit,
} from './sessionClientDurableMutationBackoff';
import {
    appendSessionClientDurableMutationDeadLetters,
    createSessionClientDurableMutationDeadLetterEntry,
    loadSessionClientDurableMutationDeadLetters,
    loadSessionClientDurableMutationOutbox,
    recoverAuthoritativeSessionClientDurableMutationDeadLetters,
    resolveSessionClientDurableMutationReferencedPrerequisiteMaxEntries,
    resolveSessionClientDurableMutationOutboxPath,
    saveSessionClientDurableMutationOutbox,
    type SessionClientDurableMutationDeadLetterEntry,
} from './sessionClientDurableMutationPersistence';
import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import { deliverSessionTurnMutation, type UnsupportedSessionTurnMutationDiagnostic } from './deliverSessionTurnMutation';
import { deliverTranscriptMessageMutation } from './deliverTranscriptMessageMutation';
import { withSessionClientDurableMutationDeliverySlot } from './sessionClientDurableMutationDeliveryLimiter';
import { shouldDeadLetterSessionClientDurableMutation } from './sessionClientDurableMutationDurabilityPolicy';
import type {
    QueuedSessionClientDurableMutation,
    RegisteredSessionStateFieldMutationV1,
    SessionClientDurableMutationDependency,
    SessionClientDurableMutationPause,
    SessionEndMutationV1,
    SessionClientDurableMutationSocket,
    TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';
import { resolveTranscriptMessageAppendMutationId } from './sessionClientDurableMutationTypes';

export type SessionClientDurableMutationOutbox = Readonly<{
    enqueueSessionTurnMutation(mutation: SessionTurnMutationV1): Promise<void>;
    enqueueSessionEnd(mutation: SessionEndMutationV1): Promise<void>;
    enqueueTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueRegisteredSessionStateFieldMutation(mutation: RegisteredSessionStateFieldMutationV1): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

type CreateSessionClientDurableMutationOutboxParams = Readonly<{
    token: string;
    sessionId: string;
    getSocket: () => SessionClientDurableMutationSocket | null;
    requestReconnect: (reason: string) => void;
    deliverRegisteredSessionStateFieldMutation?: (
        mutation: RegisteredSessionStateFieldMutationV1,
    ) => Promise<boolean>;
}>;

const loggedUnsupportedSessionTurnMutationDiagnostics = new Set<string>();

type SharedSessionClientDurableMutationOutbox = Readonly<{
    outbox: SessionClientDurableMutationOutbox;
    handles: Map<symbol, CreateSessionClientDurableMutationOutboxParams>;
}>;

const sharedSessionClientDurableMutationOutboxes = new Map<string, SharedSessionClientDurableMutationOutbox>();

function selectActiveSessionClientDurableMutationOutboxHandle(
    handles: Map<symbol, CreateSessionClientDurableMutationOutboxParams>,
): CreateSessionClientDurableMutationOutboxParams {
    const candidates = [...handles.values()];
    const connected = candidates.find((candidate) => {
        try {
            return candidate.getSocket()?.connected === true;
        } catch {
            return false;
        }
    });
    const selected = connected ?? candidates[candidates.length - 1];
    if (!selected) throw new Error('Durable session mutation outbox has no active handle');
    return selected;
}

function createQueuedSessionTurnMutation(mutation: SessionTurnMutationV1): QueuedSessionClientDurableMutation {
    const now = Date.now();
    return {
        kind: 'session_turn_mutation',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedSessionEnd(mutation: SessionEndMutationV1): QueuedSessionClientDurableMutation {
    const now = Date.now();
    return {
        kind: 'session_end',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): QueuedSessionClientDurableMutation {
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
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedRegisteredSessionStateFieldMutation(
    mutation: RegisteredSessionStateFieldMutationV1,
): QueuedSessionClientDurableMutation {
    const now = Date.now();
    return {
        kind: 'registered_session_state_field',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
        ...(mutation.dependsOn && mutation.dependsOn.length > 0 ? { dependsOn: mutation.dependsOn } : {}),
    };
}

function readTranscriptSidechain(mutation: QueuedSessionClientDurableMutation): string | null | undefined {
    if (mutation.kind !== 'transcript_message_append') return undefined;
    return mutation.payload.sidechainId ?? null;
}

function readTranscriptCoalesceKey(mutation: QueuedSessionClientDurableMutation): string | null {
    if (mutation.kind !== 'transcript_message_append') return null;
    return resolveTranscriptMessageAppendMutationId({
        sessionId: mutation.payload.sessionId,
        localId: mutation.payload.localId,
    });
}

function readTranscriptUpdatedAt(mutation: QueuedSessionClientDurableMutation): number {
    if (mutation.kind !== 'transcript_message_append') return Number.NEGATIVE_INFINITY;
    return Number.isFinite(mutation.payload.updatedAt) ? mutation.payload.updatedAt : mutation.createdAt;
}

function assertTranscriptCoalescingCompatible(
    mutation: QueuedSessionClientDurableMutation,
    queued: readonly QueuedSessionClientDurableMutation[],
): void {
    if (mutation.kind !== 'transcript_message_append') return;
    const nextCoalesceKey = readTranscriptCoalesceKey(mutation);
    const nextSidechainId = readTranscriptSidechain(mutation);
    const conflicting = queued.find((candidate) => (
        candidate.kind === 'transcript_message_append'
        && readTranscriptCoalesceKey(candidate) === nextCoalesceKey
        && readTranscriptSidechain(candidate) !== nextSidechainId
    ));
    if (!conflicting) return;
    throw new Error('Cannot coalesce transcript snapshot with reused localId across different sidechains');
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

type DurableMutationDeliveryOutcome = Readonly<{
    delivered: boolean;
    ignoredLossy?: boolean;
    unsupportedCapability?: boolean;
    paused?: SessionClientDurableMutationPause;
}>;

type DurableMutationDependencyState =
    | Readonly<{ status: 'ready' }>
    | Readonly<{ status: 'pending'; dependency: SessionClientDurableMutationDependency }>
    | Readonly<{
        status: 'failed';
        dependency: SessionClientDurableMutationDependency;
        prerequisiteReason: string;
    }>;

type DurableFailedMutationReasonPruneResult = Readonly<{
    reasons: Map<string, string>;
    retainedFailedReasonCount: number;
    prunedFailedReasonCount: number;
    failedReasonOverflowCount: number;
}>;

function readQueuedMutationObservedAt(mutation: QueuedSessionClientDurableMutation): number {
    if (mutation.kind === 'transcript_message_append') {
        return Number.isFinite(mutation.payload.updatedAt) ? mutation.payload.updatedAt : mutation.createdAt;
    }
    const observedAt = mutation.payload.observedAt;
    return Number.isFinite(observedAt) ? observedAt : mutation.createdAt;
}

function readQueuedMutationDependencies(
    mutation: QueuedSessionClientDurableMutation,
): readonly SessionClientDurableMutationDependency[] {
    if (mutation.dependsOn) return mutation.dependsOn;
    return mutation.kind === 'registered_session_state_field'
        ? mutation.payload.dependsOn ?? []
        : [];
}

function pruneDurableFailedMutationReasons(params: Readonly<{
    reasons: ReadonlyMap<string, string>;
    queued: readonly QueuedSessionClientDurableMutation[];
    maxRetainedPrerequisites: number;
}>): DurableFailedMutationReasonPruneResult {
    const retained = new Map<string, string>();
    let failedReasonOverflowCount = 0;
    for (const mutation of params.queued) {
        for (const dependency of readQueuedMutationDependencies(mutation)) {
            if (retained.has(dependency.mutationId)) continue;
            const reason = params.reasons.get(dependency.mutationId);
            if (!reason) continue;
            if (retained.size >= params.maxRetainedPrerequisites) {
                failedReasonOverflowCount += 1;
                continue;
            }
            retained.set(dependency.mutationId, reason);
        }
    }
    return {
        reasons: retained,
        retainedFailedReasonCount: retained.size,
        prunedFailedReasonCount: Math.max(0, params.reasons.size - retained.size),
        failedReasonOverflowCount,
    };
}

function resolvePausedMutation(
    mutation: QueuedSessionClientDurableMutation,
    paused: SessionClientDurableMutationPause,
): QueuedSessionClientDurableMutation {
    return {
        ...mutation,
        paused,
        nextAttemptAt: paused.resumeAtMs ?? mutation.nextAttemptAt,
    } as QueuedSessionClientDurableMutation;
}

function clearPausedMutation(
    mutation: QueuedSessionClientDurableMutation,
): QueuedSessionClientDurableMutation {
    const { paused: _paused, ...rest } = mutation;
    return rest as QueuedSessionClientDurableMutation;
}

function createSessionAuthPause(error: unknown): SessionClientDurableMutationPause {
    const now = Date.now();
    const status = readAuthenticationStatus(error);
    return {
        reason: 'session_auth_recovery',
        pausedAt: now,
        resumeAtMs: now + resolveSessionClientDurableMutationRetryDelayMs(0),
        ...(status ? { diagnostic: { status } } : {}),
    };
}

function readQueuedMutationCoalesceKey(mutation: QueuedSessionClientDurableMutation): string | null {
    const transcriptKey = readTranscriptCoalesceKey(mutation);
    if (transcriptKey) return transcriptKey;
    if (mutation.kind === 'session_end') return `session_end:${mutation.payload.sessionId}`;
    if (mutation.kind === 'registered_session_state_field') {
        return `registered_session_state_field:${mutation.payload.sessionId}:${mutation.payload.fieldId}`;
    }
    return null;
}

function resolveCoalescedMutation(
    existing: QueuedSessionClientDurableMutation,
    incoming: QueuedSessionClientDurableMutation,
): QueuedSessionClientDurableMutation {
    if (existing.kind === 'transcript_message_append' && incoming.kind === 'transcript_message_append') {
        return readTranscriptUpdatedAt(incoming) >= readTranscriptUpdatedAt(existing)
            ? incoming
            : existing;
    }
    if (existing.kind === 'session_end' && incoming.kind === 'session_end') {
        return readQueuedMutationObservedAt(incoming) >= readQueuedMutationObservedAt(existing)
            ? incoming
            : existing;
    }
    if (
        existing.kind === 'registered_session_state_field'
        && incoming.kind === 'registered_session_state_field'
    ) {
        return readQueuedMutationObservedAt(incoming) >= readQueuedMutationObservedAt(existing)
            ? incoming
            : existing;
    }
    return incoming;
}

function mergeQueuedSessionClientDurableMutations(
    earlier: readonly QueuedSessionClientDurableMutation[],
    later: readonly QueuedSessionClientDurableMutation[],
): QueuedSessionClientDurableMutation[] {
    const merged = [...earlier];
    for (const mutation of later) {
        const mutationCoalesceKey = readQueuedMutationCoalesceKey(mutation);
        const existingIndex = merged.findIndex((queued) => (
            mutationCoalesceKey
                ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                : queued.mutationId === mutation.mutationId
        ));
        if (existingIndex >= 0) {
            merged[existingIndex] = resolveCoalescedMutation(merged[existingIndex]!, mutation);
        } else {
            merged.push(mutation);
        }
    }
    return merged;
}

function pruneSessionEndsSupersededByLaterTurnBegins(
    queued: readonly QueuedSessionClientDurableMutation[],
): QueuedSessionClientDurableMutation[] {
    let latestTurnBeginObservedAt = -Infinity;
    for (const mutation of queued) {
        if (mutation.kind !== 'session_turn_mutation' || mutation.payload.action !== 'begin') continue;
        latestTurnBeginObservedAt = Math.max(latestTurnBeginObservedAt, readQueuedMutationObservedAt(mutation));
    }
    if (!Number.isFinite(latestTurnBeginObservedAt)) return [...queued];
    return queued.filter((mutation) => (
        mutation.kind !== 'session_end'
        || readQueuedMutationObservedAt(mutation) >= latestTurnBeginObservedAt
    ));
}

export function createSessionClientDurableMutationOutbox(
    params: CreateSessionClientDurableMutationOutboxParams,
): SessionClientDurableMutationOutbox {
    const outboxPath = resolveSessionClientDurableMutationOutboxPath(params.sessionId);
    let shared = sharedSessionClientDurableMutationOutboxes.get(outboxPath);
    if (!shared) {
        const handles = new Map<symbol, CreateSessionClientDurableMutationOutboxParams>();
        shared = {
            handles,
            outbox: createSessionClientDurableMutationOutboxInstance({
                token: params.token,
                sessionId: params.sessionId,
                getSocket: () => selectActiveSessionClientDurableMutationOutboxHandle(handles).getSocket(),
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
                deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                    const deliver = selectActiveSessionClientDurableMutationOutboxHandle(handles)
                        .deliverRegisteredSessionStateFieldMutation;
                    return deliver ? await deliver(mutation) : false;
                },
            }),
        };
        sharedSessionClientDurableMutationOutboxes.set(outboxPath, shared);
    }

    const sharedEntry = shared;
    const handleId = Symbol(params.sessionId);
    let handleClosed = false;
    sharedEntry.handles.set(handleId, params);

    const closeHandle = async (): Promise<void> => {
        if (handleClosed) return;
        handleClosed = true;
        const current = sharedSessionClientDurableMutationOutboxes.get(outboxPath);
        if (!current) return;
        current.handles.delete(handleId);
        if (current.handles.size > 0) return;
        sharedSessionClientDurableMutationOutboxes.delete(outboxPath);
        await current.outbox.close();
    };

    return {
        enqueueSessionTurnMutation: async (mutation) => {
            if (handleClosed) return;
            await sharedEntry.outbox.enqueueSessionTurnMutation(mutation);
        },
        enqueueSessionEnd: async (mutation) => {
            if (handleClosed) return;
            await sharedEntry.outbox.enqueueSessionEnd(mutation);
        },
        enqueueTranscriptMessage: async (mutation) => {
            if (handleClosed) return { persisted: false, delivered: false };
            return await sharedEntry.outbox.enqueueTranscriptMessage(mutation);
        },
        enqueueRegisteredSessionStateFieldMutation: async (mutation) => {
            if (handleClosed) return;
            await sharedEntry.outbox.enqueueRegisteredSessionStateFieldMutation(mutation);
        },
        flush: async (reason) => {
            if (handleClosed) return;
            await sharedEntry.outbox.flush(reason);
        },
        close: closeHandle,
    };
}

function createSessionClientDurableMutationOutboxInstance(
    params: CreateSessionClientDurableMutationOutboxParams,
): SessionClientDurableMutationOutbox {
    let closed = false;
    let mutations: QueuedSessionClientDurableMutation[] = [];
    let inFlightMutations: QueuedSessionClientDurableMutation[] = [];
    let flushInFlight: Promise<void> | null = null;
    let persistInFlight: Promise<void> = Promise.resolve();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let loadedMutationsNeedPersist = false;
    let durableFailedMutationReasons = new Map<string, string>();
    let deadLetterRecoveryTail: Promise<void> = Promise.resolve();

    async function recoverDeadLetteredAuthoritativeMutations(): Promise<void> {
        const recover = async (): Promise<void> => {
            const recovered = await recoverAuthoritativeSessionClientDurableMutationDeadLetters(params.sessionId);
            if (recovered.length === 0) return;
            mutations = mergeQueuedSessionClientDurableMutations(mutations, recovered);
            loadedMutationsNeedPersist = true;
            logger.debug('[API] Re-queued authoritative durable session mutations from dead letters', {
                sessionId: params.sessionId,
                recoveredCount: recovered.length,
            });
        };
        const recovery = deadLetterRecoveryTail.then(recover, recover);
        deadLetterRecoveryTail = recovery.catch(() => undefined);
        await recovery;
    }

    const ready = (async () => {
        const loaded = await loadSessionClientDurableMutationOutbox(params.sessionId);
        mutations = pruneSessionEndsSupersededByLaterTurnBegins(
            mergeQueuedSessionClientDurableMutations([], loaded),
        );
        loadedMutationsNeedPersist = mutations.length !== loaded.length;
        await recoverDeadLetteredAuthoritativeMutations();
        const deadLetters = await loadSessionClientDurableMutationDeadLetters(params.sessionId);
        durableFailedMutationReasons = createDurableFailedMutationReasons(deadLetters);
        return undefined;
    })()
        .then(() => {
            pruneDurableFailedMutationReasonsForQueuedDependents('startup');
        })
        .catch((error) => {
            logger.debug('[API] Failed to load durable session mutation outbox', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });

    function createDurableFailedMutationReasons(
        deadLetters: readonly SessionClientDurableMutationDeadLetterEntry[],
    ): Map<string, string> {
        const reasons = new Map<string, string>();
        for (const deadLetter of deadLetters) {
            if (!deadLetter.mutationId) continue;
            if (typeof deadLetter.recoveryAttemptedAt === 'number') continue;
            reasons.set(deadLetter.mutationId, deadLetter.reason);
        }
        return reasons;
    }

    function pruneDurableFailedMutationReasonsForQueuedDependents(reason: string): void {
        const result = pruneDurableFailedMutationReasons({
            reasons: durableFailedMutationReasons,
            queued: mergeQueuedSessionClientDurableMutations(inFlightMutations, mutations),
            maxRetainedPrerequisites: resolveSessionClientDurableMutationReferencedPrerequisiteMaxEntries(),
        });
        durableFailedMutationReasons = result.reasons;
        if (result.prunedFailedReasonCount === 0 && result.failedReasonOverflowCount === 0) return;
        logger.debug('[API] Durable session mutation failed-prerequisite reason retention pruned', {
            sessionId: params.sessionId,
            reason,
            retainedFailedReasonCount: result.retainedFailedReasonCount,
            prunedFailedReasonCount: result.prunedFailedReasonCount,
            failedReasonOverflowCount: result.failedReasonOverflowCount,
        });
    }

    async function persist(): Promise<void> {
        const previousPersist = persistInFlight;
        const nextPersist = previousPersist
            .catch(() => undefined)
            .then(async () => {
                await saveSessionClientDurableMutationOutbox(
                    params.sessionId,
                    pruneSessionEndsSupersededByLaterTurnBegins(
                        mergeQueuedSessionClientDurableMutations(inFlightMutations, mutations),
                    ),
                );
            });
        persistInFlight = nextPersist;
        await nextPersist;
    }

    function clearRetryTimer(): void {
        if (!retryTimer) return;
        clearTimeout(retryTimer);
        retryTimer = null;
    }

    function resolveNextRetryAt(now: number): number {
        let transcriptNextAttemptAt = Number.POSITIVE_INFINITY;
        for (const mutation of mutations) {
            const nextAttemptAt = mutation.nextAttemptAt || now;
            if (mutation.kind === 'transcript_message_append') {
                transcriptNextAttemptAt = Math.min(transcriptNextAttemptAt, nextAttemptAt);
                continue;
            }
            return nextAttemptAt;
        }
        return Number.isFinite(transcriptNextAttemptAt) ? transcriptNextAttemptAt : now;
    }

    function scheduleRetry(): void {
        if (closed || retryTimer || mutations.length === 0) return;
        const now = Date.now();
        const nextAttemptAt = resolveNextRetryAt(now);
        const delayMs = Math.max(0, nextAttemptAt - now);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void flush('timer');
        }, delayMs);
        retryTimer.unref?.();
    }

    async function deliver(mutation: QueuedSessionClientDurableMutation): Promise<DurableMutationDeliveryOutcome> {
        if (mutation.kind === 'session_turn_mutation') {
            const result = await deliverSessionTurnMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
            if (!result.delivered && result.reason === 'unsupported_capability' && 'diagnostic' in result) {
                logUnsupportedSessionTurnMutationDiagnostic(result.diagnostic);
                return { delivered: false, unsupportedCapability: true };
            }
            if (!result.delivered && result.reason === 'ignored_lossy') {
                return { delivered: false, ignoredLossy: true };
            }
            return { delivered: result.delivered };
        }
        if (mutation.kind === 'transcript_message_append') {
            const result = await deliverTranscriptMessageMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
            return { delivered: result.delivered };
        }
        if (mutation.kind === 'registered_session_state_field') {
            if (!params.deliverRegisteredSessionStateFieldMutation) {
                return { delivered: false, unsupportedCapability: true };
            }
            return {
                delivered: await params.deliverRegisteredSessionStateFieldMutation(mutation.payload),
            };
        }
        return {
            delivered: await deliverSessionEndMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            }),
        };
    }

    async function flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void> {
        await ready;
        await recoverDeadLetteredAuthoritativeMutations().catch((error) => {
            logger.debug('[API] Failed to recover dead-lettered authoritative durable session mutations', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
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
            const now = Date.now();
            let didChange = loadedMutationsNeedPersist;
            loadedMutationsNeedPersist = false;
            let shouldRequestReconnect = false;
            const remaining: QueuedSessionClientDurableMutation[] = [];
            const prunedMutations = pruneSessionEndsSupersededByLaterTurnBegins(mutations);
            if (prunedMutations.length !== mutations.length) {
                mutations = prunedMutations;
                didChange = true;
            }
            const batch = mutations;
            mutations = [];
            inFlightMutations = batch;
            const deadLetters: SessionClientDurableMutationDeadLetterEntry[] = [];
            const failedMutationReasons = new Map(durableFailedMutationReasons);
            const resolvedMutationIds = new Set<string>();
            const batchMutationIds = new Set(batch.map((mutation) => mutation.mutationId));
            const transcriptFlushBatchLimit = reason === 'flush'
                ? Number.POSITIVE_INFINITY
                : resolveSessionClientDurableMutationTranscriptFlushBatchLimit();
            let transcriptDeliveriesThisFlush = 0;
            const refreshInFlightMutations = (nextIndex: number): void => {
                inFlightMutations = mergeQueuedSessionClientDurableMutations(remaining, batch.slice(nextIndex));
            };
            const resolveDependencyState = (
                mutation: QueuedSessionClientDurableMutation,
            ): DurableMutationDependencyState => {
                for (const dependency of readQueuedMutationDependencies(mutation)) {
                    const prerequisiteReason = failedMutationReasons.get(dependency.mutationId);
                    if (prerequisiteReason) {
                        return { status: 'failed', dependency, prerequisiteReason };
                    }
                    if (resolvedMutationIds.has(dependency.mutationId)) continue;
                    if (batchMutationIds.has(dependency.mutationId)) {
                        return { status: 'pending', dependency };
                    }
                    return {
                        status: 'failed',
                        dependency,
                        prerequisiteReason: 'missing_prerequisite_evidence',
                    };
                }
                return { status: 'ready' };
            };
            for (let index = 0; index < batch.length; index += 1) {
                let mutation = batch[index];
                const dependencyState = resolveDependencyState(mutation);
                if (dependencyState.status === 'failed') {
                    deadLetters.push(createSessionClientDurableMutationDeadLetterEntry({
                        sessionId: params.sessionId,
                        mutation,
                        reason: 'failed_prerequisite',
                        diagnostic: {
                            prerequisiteMutationId: dependencyState.dependency.mutationId,
                            relationship: dependencyState.dependency.relationship,
                            prerequisiteReason: dependencyState.prerequisiteReason,
                        },
                    }));
                    failedMutationReasons.set(mutation.mutationId, 'failed_prerequisite');
                    durableFailedMutationReasons.set(mutation.mutationId, 'failed_prerequisite');
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
                }
                if (dependencyState.status === 'pending') {
                    const blockedMutation = {
                        ...mutation,
                        nextAttemptAt: Math.max(
                            mutation.nextAttemptAt,
                            Date.now() + resolveSessionClientDurableMutationRetryDelayMs(0),
                        ),
                    } as QueuedSessionClientDurableMutation;
                    remaining.push(blockedMutation);
                    refreshInFlightMutations(index + 1);
                    didChange = didChange || blockedMutation.nextAttemptAt !== mutation.nextAttemptAt;
                    continue;
                }
                if (mutation.paused) {
                    const resumeAtMs = mutation.paused.resumeAtMs ?? Number.POSITIVE_INFINITY;
                    if (reason === 'flush' || resumeAtMs > now) {
                        remaining.push(mutation);
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                    mutation = clearPausedMutation(mutation);
                    batch[index] = mutation;
                }
                const shouldRedriveAuthoritative = (
                    (reason === 'connect' || reason === 'startup')
                    && !shouldDeadLetterSessionClientDurableMutation(mutation)
                );
                if (!shouldRedriveAuthoritative && reason !== 'flush' && mutation.nextAttemptAt > now) {
                    if (mutation.kind === 'transcript_message_append') {
                        remaining.push(mutation);
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                    remaining.push(mutation);
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    break;
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
                            Date.now() + resolveSessionClientDurableMutationRetryDelayMs(0),
                        ),
                    } as QueuedSessionClientDurableMutation);
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
                }
                if (mutation.kind === 'transcript_message_append') {
                    transcriptDeliveriesThisFlush += 1;
                }
                let outcome: DurableMutationDeliveryOutcome = { delivered: false };
                try {
                    outcome = await withSessionClientDurableMutationDeliverySlot(() => deliver(mutation));
                    if (outcome.delivered) {
                        resolvedMutationIds.add(mutation.mutationId);
                        didChange = true;
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                } catch (error) {
                    if (isAuthenticationError(error)) {
                        outcome = {
                            delivered: false,
                            paused: createSessionAuthPause(error),
                        };
                    }
                    logger.debug('[API] Durable session mutation delivery failed', {
                        sessionId: params.sessionId,
                        mutationKind: mutation.kind,
                        mutationId: mutation.mutationId,
                        error: serializeAxiosErrorForLog(error),
                    });
                }

                if (outcome.paused) {
                    remaining.push(resolvePausedMutation(mutation, outcome.paused));
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    didChange = true;
                    shouldRequestReconnect = true;
                    break;
                }

                if (outcome.ignoredLossy) {
                    resolvedMutationIds.add(mutation.mutationId);
                    didChange = true;
                    refreshInFlightMutations(index + 1);
                    continue;
                }

                if (outcome.unsupportedCapability) {
                    remaining.push({
                        ...mutation,
                        nextAttemptAt: Date.now() + resolveSessionClientDurableMutationRetryDelayMs(0),
                    } as QueuedSessionClientDurableMutation);
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    didChange = true;
                    break;
                }

                const attempts = mutation.attempts + 1;
                const failedMutation = {
                    ...mutation,
                    attempts,
                    nextAttemptAt: Date.now() + resolveSessionClientDurableMutationRetryDelayMs(attempts),
                } as QueuedSessionClientDurableMutation;
                if (
                    attempts >= resolveSessionClientDurableMutationMaxAttempts()
                    && shouldDeadLetterSessionClientDurableMutation(failedMutation)
                ) {
                    deadLetters.push(createSessionClientDurableMutationDeadLetterEntry({
                        sessionId: params.sessionId,
                        mutation: failedMutation,
                        reason: 'retry_exhausted',
                    }));
                    failedMutationReasons.set(mutation.mutationId, 'retry_exhausted');
                    durableFailedMutationReasons.set(mutation.mutationId, 'retry_exhausted');
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
                }
                remaining.push(failedMutation);
                remaining.push(...batch.slice(index + 1));
                inFlightMutations = [];
                didChange = true;
                shouldRequestReconnect = true;
                break;
            }
            mutations = mergeQueuedSessionClientDurableMutations(remaining, mutations);
            inFlightMutations = [];
            pruneDurableFailedMutationReasonsForQueuedDependents(reason);
            if (didChange) {
                await persist();
                const retention = await appendSessionClientDurableMutationDeadLetters(params.sessionId, deadLetters);
                if (
                    deadLetters.length > 0
                    || retention.cappedDeadLetterCount > 0
                    || retention.referencedRetainedEntryCount > 0
                    || retention.referencedPrerequisiteOverflowCount > 0
                ) {
                    logger.debug('[API] Durable session mutation dead-letter retention updated', {
                        sessionId: params.sessionId,
                        deadLetteredCount: deadLetters.length,
                        cappedDeadLetterCount: retention.cappedDeadLetterCount,
                        referencedRetainedEntryCount: retention.referencedRetainedEntryCount,
                        prunedEntryCount: retention.prunedEntryCount,
                        referencedPrerequisiteOverflowCount: retention.referencedPrerequisiteOverflowCount,
                    });
                }
            }
            if (!closed && mutations.length > 0) {
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
            || inFlightMutations.some((queued) => queued.mutationId === mutationId)
        );
    }

    async function enqueue(
        mutation: QueuedSessionClientDurableMutation,
        opts: Readonly<{ awaitFlush?: boolean }> = {},
    ): Promise<Readonly<{ delivered: boolean; persisted: boolean }>> {
        await ready;
        if (closed) return { delivered: false, persisted: false };
        assertTranscriptCoalescingCompatible(mutation, mutations);
        assertTranscriptCoalescingCompatible(mutation, inFlightMutations);
        mutations = mergeQueuedSessionClientDurableMutations(mutations, [mutation]);
        mutations = pruneSessionEndsSupersededByLaterTurnBegins(mutations);
        await persist();
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
        return { delivered: !hasQueuedMutation(mutation.mutationId), persisted: true };
    }

    void ready.then(() => {
        if (mutations.length > 0) {
            return flush('startup');
        }
        return undefined;
    }).catch(() => {});

    return {
        async enqueueSessionTurnMutation(mutation) {
            await enqueue(createQueuedSessionTurnMutation(mutation));
        },
        async enqueueSessionEnd(mutation) {
            await enqueue(createQueuedSessionEnd(mutation));
        },
        async enqueueTranscriptMessage(mutation) {
            const result = await enqueue(createQueuedTranscriptMessage(mutation), { awaitFlush: true });
            return { persisted: result.persisted, delivered: result.delivered };
        },
        async enqueueRegisteredSessionStateFieldMutation(mutation) {
            await enqueue(createQueuedRegisteredSessionStateFieldMutation(mutation));
        },
        flush,
        async close() {
            closed = true;
            clearRetryTimer();
            await ready;
            await flush('flush');
            clearRetryTimer();
            if (mutations.length > 0 || inFlightMutations.length > 0) {
                await persist();
            }
        },
    };
}
