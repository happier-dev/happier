import { logger } from '@/ui/logger';
import { isDeepStrictEqual } from 'node:util';
import { configuration } from '@/configuration';
import { isAuthenticationError, readAuthenticationStatus } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { SessionSyncPendingInputServerContractResult } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import {
    SessionRuntimeActivityProjectionSchema,
    SessionRuntimeActivitySnapshotSchema,
    type ExactSessionTurnEndMutationV1,
    type SessionRuntimeActivityProjection,
    type SessionRuntimeActivitySnapshot,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';

import {
    resolveSessionClientDurableMutationMaxAttempts,
    resolveSessionClientDurableMutationRetryDelayMs,
    resolveSessionClientDurableMutationTranscriptFlushBatchLimit,
} from './sessionClientDurableMutationBackoff';
import {
    appendSessionClientDurableMutationDeadLetters,
    createSessionClientDurableMutationPersistenceContext,
    createSessionClientDurableMutationDeadLetterEntry,
    loadSessionClientDurableMutationDeadLetters,
    loadSessionClientDurableMutationOutbox,
    markAuthoritativeSessionClientDurableMutationDeadLettersRecovered,
    parseDaemonSessionClientDurableMutation,
    parseRuntimeSessionClientDurableMutation,
    recoverAuthoritativeSessionClientDurableMutationDeadLetters,
    resolveSessionClientDurableMutationReferencedPrerequisiteMaxEntries,
    resolveSessionClientDurableMutationOutboxPath,
    saveSessionClientDurableMutationOutbox,
    type SessionClientDurableMutationDeadLetterEntry,
    type SessionClientDurableMutationPersistenceContext,
} from './sessionClientDurableMutationPersistence';
import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import { deliverSessionTurnMutation, type UnsupportedSessionTurnMutationDiagnostic } from './deliverSessionTurnMutation';
import { deliverTranscriptMessageMutation } from './deliverTranscriptMessageMutation';
import { withSessionClientDurableMutationDeliverySlot } from './sessionClientDurableMutationDeliveryLimiter';
import { shouldDeadLetterSessionClientDurableMutation } from './sessionClientDurableMutationDurabilityPolicy';
import type {
    DaemonUsageLimitRecoveryFieldMutation,
    QueuedSessionClientDurableMutation,
    RegisteredSessionStateFieldMutationV1,
    SessionClientDurableMutationDependency,
    SessionClientDurableMutationPause,
    SessionClientDurableMutationSocket,
    TranscriptMessageAppendMutationV1,
    VoiceAgentTranscriptTurnMutationV1,
} from './sessionClientDurableMutationTypes';
import {
    resolveRuntimeActivitySnapshotMutationId,
    resolveTranscriptMessageAppendMutationId,
    resolveVoiceAgentTranscriptTurnMutationId,
    requireTranscriptMessageAppendProvenance,
} from './sessionClientDurableMutationTypes';

type GenericSessionClientDurableMutationOutbox = Readonly<{
    enqueueSessionTurnMutation(mutation: SessionTurnMutationV1): Promise<void>;
    enqueueTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueVoiceAgentTranscriptTurn(mutation: VoiceAgentTranscriptTurnMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueRegisteredSessionStateFieldMutation(mutation: RegisteredSessionStateFieldMutationV1): Promise<void>;
    enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
        mutation: RegisteredSessionStateFieldMutationV1,
        opts?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<RegisteredSessionStateFieldWaitResult>;
    setSessionSyncPendingInputServerContract(result: SessionSyncPendingInputServerContractResult): Promise<void>;
    readRuntimeActivitySnapshotTail(): RuntimeActivitySnapshotTail;
    waitForRuntimeActivitySnapshotTailChange(sequence: number, signal?: AbortSignal): Promise<boolean>;
    awaitReady(): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

type GenericSessionClientDurableMutationOutboxInstance = GenericSessionClientDurableMutationOutbox;

export class SessionMutationJournalAdmissionBlockedError extends Error {
    override readonly cause: unknown;

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'SessionMutationJournalAdmissionBlockedError';
        this.cause = cause;
    }
}

export type RegisteredSessionStateFieldAppliedSettlement = Readonly<{
    status: 'applied' | 'unchanged';
    committedProjection: unknown;
    committedRevision: number;
}>;

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

export type RegisteredSessionStateFieldWaitResult =
    | Readonly<{ status: 'applied' | 'unchanged'; committedProjection: unknown; committedRevision: number }>
    | Readonly<{ status: 'applied' | 'superseded' | 'failed' | 'cancelled' }>;

type RegisteredSessionStateFieldDeliveryResult =
    | boolean
    | Readonly<{
        delivered: boolean;
        settlement: 'applied' | 'superseded' | RegisteredSessionStateFieldAppliedSettlement;
    }>
    | Readonly<{
        delivered: false;
        unsupportedCapability: true;
    }>;

type CreateGenericSessionClientDurableMutationOutboxParams = Readonly<{
    token: string;
    sessionId: string;
    persistenceContext?: SessionClientDurableMutationPersistenceContext;
    initialRegisteredSessionStateFieldMutations?: readonly RegisteredSessionStateFieldMutationV1[];
    flushOnReady?: boolean;
    supportsSocketDelivery?: boolean;
    isDeliveryActive?: () => boolean;
    isShuttingDown?: () => boolean;
    runtimeActivitySupportControlled?: boolean;
    getSocket: () => SessionClientDurableMutationSocket | null;
    requestReconnect: (reason: string) => void;
    deliverRegisteredSessionStateFieldMutation?: (
        mutation: RegisteredSessionStateFieldMutationV1,
    ) => Promise<RegisteredSessionStateFieldDeliveryResult>;
}>;

const loggedUnsupportedSessionTurnMutationDiagnostics = new Set<string>();

type SharedGenericSessionClientDurableMutationOutbox = Readonly<{
    outbox: GenericSessionClientDurableMutationOutboxInstance;
    handles: Map<symbol, CreateGenericSessionClientDurableMutationOutboxParams>;
}>;

const sharedGenericSessionClientDurableMutationOutboxes = new Map<string, SharedGenericSessionClientDurableMutationOutbox>();
const closingGenericSessionClientDurableMutationOutboxes = new Map<string, Promise<void>>();

export async function resetSessionClientDurableMutationOutboxStateForTests(): Promise<void> {
    const sharedOutboxes = [...sharedGenericSessionClientDurableMutationOutboxes.values()];
    const closingOutboxes = [...closingGenericSessionClientDurableMutationOutboxes.values()];
    sharedGenericSessionClientDurableMutationOutboxes.clear();
    closingGenericSessionClientDurableMutationOutboxes.clear();
    loggedUnsupportedSessionTurnMutationDiagnostics.clear();
    await Promise.all(sharedOutboxes.map(async ({ outbox }) => {
        await outbox.close().catch(() => undefined);
    }));
    await Promise.all(closingOutboxes.map(async (closing) => {
        await closing.catch(() => undefined);
    }));
}

function selectActiveGenericSessionClientDurableMutationOutboxHandle(
    handles: Map<symbol, CreateGenericSessionClientDurableMutationOutboxParams>,
    isEligible: (candidate: CreateGenericSessionClientDurableMutationOutboxParams) => boolean = () => true,
): CreateGenericSessionClientDurableMutationOutboxParams {
    const candidates = [...handles.values()].filter(isEligible).reverse();
    const selected = candidates[0];
    if (!selected) throw new Error('Durable session mutation outbox has no active handle');
    return selected;
}

function createQueuedSessionTurnMutation(
    mutation: SessionTurnMutationV1,
): Extract<QueuedSessionClientDurableMutation, Readonly<{ kind: 'session_turn_mutation' }>> {
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

function createQueuedTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): QueuedSessionClientDurableMutation {
    requireTranscriptMessageAppendProvenance(mutation.provenance);
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

function createQueuedVoiceAgentTranscriptTurn(
    mutation: VoiceAgentTranscriptTurnMutationV1,
): QueuedSessionClientDurableMutation {
    const canonicalMutationId = resolveVoiceAgentTranscriptTurnMutationId({
        sessionId: mutation.sessionId,
        turnId: mutation.turnId,
    });
    if (mutation.mutationId !== canonicalMutationId) {
        throw new Error('Voice-agent transcript turn mutation id must match the canonical session/turn key');
    }
    if (
        mutation.user.sessionId !== mutation.sessionId
        || mutation.assistant.sessionId !== mutation.sessionId
        || mutation.user.messageRole !== 'user'
        || mutation.assistant.messageRole !== 'agent'
        || mutation.user.localId === mutation.assistant.localId
    ) {
        throw new Error('Voice-agent transcript turn requires distinct user and agent role mutations in one session');
    }
    requireTranscriptMessageAppendProvenance(mutation.user.provenance);
    requireTranscriptMessageAppendProvenance(mutation.assistant.provenance);
    return {
        kind: 'voice_agent_transcript_turn',
        mutationId: canonicalMutationId,
        payload: mutation,
        createdAt: Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function isTranscriptDeliveryMutation(mutation: QueuedSessionClientDurableMutation): boolean {
    return mutation.kind === 'transcript_message_append' || mutation.kind === 'voice_agent_transcript_turn';
}

function assertVoiceAgentTranscriptTurnCompatible(
    mutation: QueuedSessionClientDurableMutation,
    queued: readonly QueuedSessionClientDurableMutation[],
): void {
    if (mutation.kind !== 'voice_agent_transcript_turn') return;
    const existing = queued.find((candidate) => (
        candidate.kind === 'voice_agent_transcript_turn'
        && candidate.mutationId === mutation.mutationId
    ));
    if (!existing) return;
    if (JSON.stringify(existing.payload) !== JSON.stringify(mutation.payload)) {
        throw new Error('Voice-agent transcript turn identity cannot be reused with different role payloads');
    }
}

function createQueuedRegisteredSessionStateFieldMutation(
    mutation: RegisteredSessionStateFieldMutationV1,
): QueuedSessionClientDurableMutation {
    const now = Date.now();
    const mutationId = mutation.fieldId === 'runtime.activity'
        ? resolveRuntimeActivitySnapshotMutationId(mutation.sessionId)
        : mutation.mutationId;
    const payload = mutationId === mutation.mutationId
        ? mutation
        : { ...mutation, mutationId };
    return {
        kind: 'registered_session_state_field',
        mutationId,
        payload,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
        ...(payload.dependsOn && payload.dependsOn.length > 0 ? { dependsOn: payload.dependsOn } : {}),
    };
}

function normalizeQueuedRuntimeActivityIdentity(
    mutation: QueuedSessionClientDurableMutation,
): QueuedSessionClientDurableMutation {
    if (
        mutation.kind !== 'registered_session_state_field'
        || mutation.payload.fieldId !== 'runtime.activity'
    ) {
        return mutation;
    }
    const mutationId = resolveRuntimeActivitySnapshotMutationId(mutation.payload.sessionId);
    if (mutation.mutationId === mutationId && mutation.payload.mutationId === mutationId) {
        return mutation;
    }
    return {
        ...mutation,
        mutationId,
        payload: {
            ...mutation.payload,
            mutationId,
        },
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
    const provenanceConflict = queued.find((candidate) => (
        candidate.kind === 'transcript_message_append'
        && readTranscriptCoalesceKey(candidate) === nextCoalesceKey
        && !isDeepStrictEqual(candidate.payload.provenance, mutation.payload.provenance)
    ));
    if (provenanceConflict) {
        throw new Error('Cannot coalesce transcript snapshot across different causal provenance');
    }
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
    registeredFieldSettlement?: PendingRegisteredFieldSettlement;
    runtimeActivitySettlement?: NonNullable<RuntimeActivitySnapshotTail['settlement']>;
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

type RegisteredFieldSettlementStatus = 'applied' | 'superseded' | 'failed' | RegisteredSessionStateFieldAppliedSettlement;

type RegisteredFieldWaiter = Readonly<{
    resolve: (status: RegisteredFieldSettlementStatus | 'cancelled') => void;
    reject: (error: unknown) => void;
}>;

type RegisteredFieldSettlementGroup = {
    activeMutationId: string;
    activeAdmissionOrder: number | null;
    completed: boolean;
    error: unknown;
    settled: RegisteredFieldSettlementStatus | null;
    waiters: Set<RegisteredFieldWaiter>;
};

type PendingRegisteredFieldSettlement = Readonly<{
    mutationId: string;
    admissionOrder: number;
    group: RegisteredFieldSettlementGroup;
    status: RegisteredFieldSettlementStatus;
}>;

function readQueuedMutationObservedAt(mutation: QueuedSessionClientDurableMutation): number {
    if (mutation.kind === 'transcript_message_append') {
        return Number.isFinite(mutation.payload.updatedAt) ? mutation.payload.updatedAt : mutation.createdAt;
    }
    const observedAt = mutation.payload.observedAt;
    return Number.isFinite(observedAt) ? observedAt : mutation.createdAt;
}

function readRegisteredFieldAdmissionOrder(mutation: QueuedSessionClientDurableMutation): number | null {
    return mutation.kind === 'registered_session_state_field'
        && typeof mutation.admissionOrder === 'number'
        && Number.isSafeInteger(mutation.admissionOrder)
        && mutation.admissionOrder > 0
        ? mutation.admissionOrder
        : null;
}

function readRuntimeActivityDesiredValue(
    mutation: QueuedSessionClientDurableMutation,
): SessionRuntimeActivitySnapshot | null {
    if (
        mutation.kind !== 'registered_session_state_field'
        || mutation.payload.fieldId !== 'runtime.activity'
    ) return null;
    if (mutation.payload.op.kind === 'clear') {
        return { state: 'unknown', activeCount: 0 };
    }
    const parsed = SessionRuntimeActivitySnapshotSchema.safeParse(mutation.payload.op.value);
    return parsed.success ? parsed.data : null;
}

function readRuntimeActivityCustody(
    mutation: QueuedSessionClientDurableMutation,
): RuntimeActivitySnapshotTail['custody'] {
    const value = readRuntimeActivityDesiredValue(mutation);
    const admissionOrder = readRegisteredFieldAdmissionOrder(mutation);
    if (value === null || admissionOrder === null) return null;
    return {
        identity: {
            mutationKey: mutation.mutationId,
            admissionOrder,
        },
        value,
    };
}

function readRuntimeActivitySettlement(
    mutation: QueuedSessionClientDurableMutation,
    settlement: RegisteredFieldSettlementStatus,
): RuntimeActivitySnapshotTail['settlement'] {
    if (typeof settlement === 'string') return null;
    const desiredValue = readRuntimeActivityDesiredValue(mutation);
    const admissionOrder = readRegisteredFieldAdmissionOrder(mutation);
    const committedProjection = SessionRuntimeActivityProjectionSchema.safeParse(
        settlement.committedProjection,
    );
    if (
        desiredValue === null
        || admissionOrder === null
        || !committedProjection.success
        || committedProjection.data.revision !== settlement.committedRevision
    ) return null;
    return {
        identity: {
            mutationKey: mutation.mutationId,
            admissionOrder,
        },
        desiredValue,
        result: settlement.status,
        committedProjection: committedProjection.data,
        committedRevision: settlement.committedRevision,
    };
}

function registeredFieldValuesEqual(
    left: QueuedSessionClientDurableMutation,
    right: QueuedSessionClientDurableMutation,
): boolean {
    return left.kind === 'registered_session_state_field'
        && right.kind === 'registered_session_state_field'
        && left.payload.mutationId === right.payload.mutationId
        && JSON.stringify(left.payload.op) === JSON.stringify(right.payload.op);
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
    if (mutation.kind === 'voice_agent_transcript_turn') return mutation.mutationId;
    if (mutation.kind === 'session_end') return `session_end:${mutation.payload.sessionId}`;
    if (mutation.kind === 'registered_session_state_field') {
        return `registered_session_state_field:${mutation.payload.sessionId}:${mutation.payload.fieldId}`;
    }
    return null;
}

function readCapabilityBlockKey(mutation: QueuedSessionClientDurableMutation): string {
    return mutation.kind === 'registered_session_state_field'
        ? `${mutation.kind}:${mutation.payload.fieldId}`
        : mutation.kind;
}

function resolveCoalescedMutation(
    existing: QueuedSessionClientDurableMutation,
    incoming: QueuedSessionClientDurableMutation,
): QueuedSessionClientDurableMutation {
    if (existing.kind === 'transcript_message_append' && incoming.kind === 'transcript_message_append') {
        if (!isDeepStrictEqual(existing.payload.provenance, incoming.payload.provenance)) {
            throw new Error('Cannot coalesce transcript snapshot across different causal provenance');
        }
        if (existing.payload.createdAt !== incoming.payload.createdAt) {
            return existing;
        }
        return readTranscriptUpdatedAt(incoming) >= readTranscriptUpdatedAt(existing)
            ? incoming
            : existing;
    }
    if (existing.kind === 'voice_agent_transcript_turn' && incoming.kind === 'voice_agent_transcript_turn') {
        return existing;
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
        const existingAdmissionOrder = readRegisteredFieldAdmissionOrder(existing);
        const incomingAdmissionOrder = readRegisteredFieldAdmissionOrder(incoming);
        if (incomingAdmissionOrder !== null) {
            return existingAdmissionOrder === null || incomingAdmissionOrder > existingAdmissionOrder
                ? incoming
                : existing;
        }
        if (existingAdmissionOrder !== null) return existing;
        return readQueuedMutationObservedAt(incoming) >= readQueuedMutationObservedAt(existing)
            ? incoming
            : existing;
    }
    return incoming;
}

type QueuedMutationOwnershipReplacement = Readonly<{
    supersededMutationId: string;
    survivingMutationId: string;
}>;

type QueuedMutationMergeResult = Readonly<{
    mutations: QueuedSessionClientDurableMutation[];
    replacements: QueuedMutationOwnershipReplacement[];
}>;

function mergeQueuedSessionClientDurableMutationsWithOwnership(
    earlier: readonly QueuedSessionClientDurableMutation[],
    later: readonly QueuedSessionClientDurableMutation[],
): QueuedMutationMergeResult {
    const merged = [...earlier];
    const replacements: QueuedMutationOwnershipReplacement[] = [];
    for (const mutation of later) {
        const mutationCoalesceKey = readQueuedMutationCoalesceKey(mutation);
        const existingIndex = merged.findIndex((queued) => (
            mutationCoalesceKey
                ? readQueuedMutationCoalesceKey(queued) === mutationCoalesceKey
                : queued.mutationId === mutation.mutationId
        ));
        if (existingIndex < 0) {
            merged.push(mutation);
            continue;
        }
        const existing = merged[existingIndex]!;
        const surviving = resolveCoalescedMutation(existing, mutation);
        merged[existingIndex] = surviving;
        const superseded = surviving === existing ? mutation : existing;
        if (superseded.mutationId !== surviving.mutationId) {
            replacements.push({
                supersededMutationId: superseded.mutationId,
                survivingMutationId: surviving.mutationId,
            });
        }
    }
    return { mutations: merged, replacements };
}

function mergeQueuedSessionClientDurableMutations(
    earlier: readonly QueuedSessionClientDurableMutation[],
    later: readonly QueuedSessionClientDurableMutation[],
): QueuedSessionClientDurableMutation[] {
    return mergeQueuedSessionClientDurableMutationsWithOwnership(earlier, later).mutations;
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

function createGenericSessionClientDurableMutationOutbox(
    params: CreateGenericSessionClientDurableMutationOutboxParams,
): GenericSessionClientDurableMutationOutbox {
    const outboxPath = params.persistenceContext?.paths.queuePath
        ?? resolveSessionClientDurableMutationOutboxPath(params.sessionId);
    const closing = closingGenericSessionClientDurableMutationOutboxes.get(outboxPath);
    if (closing) {
        let handleClosed = false;
        let reopened: Promise<GenericSessionClientDurableMutationOutbox> | null = null;
        const resolveReopened = async (): Promise<GenericSessionClientDurableMutationOutbox | null> => {
            if (handleClosed) return null;
            reopened ??= closing.then(() => createGenericSessionClientDurableMutationOutbox(params));
            return await reopened;
        };
        return {
            enqueueSessionTurnMutation: async (mutation) => { await (await resolveReopened())?.enqueueSessionTurnMutation(mutation); },
            enqueueTranscriptMessage: async (mutation) => (
                await (await resolveReopened())?.enqueueTranscriptMessage(mutation)
                ?? { persisted: false, delivered: false }
            ),
            enqueueVoiceAgentTranscriptTurn: async (mutation) => (
                await (await resolveReopened())?.enqueueVoiceAgentTranscriptTurn(mutation)
                ?? { persisted: false, delivered: false }
            ),
            enqueueRegisteredSessionStateFieldMutation: async (mutation) => {
                await (await resolveReopened())?.enqueueRegisteredSessionStateFieldMutation(mutation);
            },
            enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery: async (mutation, opts) => (
                await (await resolveReopened())?.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(mutation, opts)
                ?? { status: 'failed' }
            ),
            setSessionSyncPendingInputServerContract: async (result) => {
                await (await resolveReopened())?.setSessionSyncPendingInputServerContract(result);
            },
            readRuntimeActivitySnapshotTail: () => ({
                sequence: 0,
                custody: null,
                settlement: null,
            }),
            waitForRuntimeActivitySnapshotTailChange: async (sequence, signal) => (
                await (await resolveReopened())?.waitForRuntimeActivitySnapshotTailChange(sequence, signal)
                ?? false
            ),
            awaitReady: async () => { await (await resolveReopened())?.awaitReady(); },
            flush: async (reason) => { await (await resolveReopened())?.flush(reason); },
            close: async () => {
                handleClosed = true;
                const created = reopened ? await reopened : null;
                await created?.close();
                await closing;
            },
        };
    }
    let shared = sharedGenericSessionClientDurableMutationOutboxes.get(outboxPath);
    if (!shared) {
        const handles = new Map<symbol, CreateGenericSessionClientDurableMutationOutboxParams>();
        shared = {
            handles,
            outbox: createGenericSessionClientDurableMutationOutboxInstance({
                get token() {
                    return selectActiveGenericSessionClientDurableMutationOutboxHandle(
                        handles,
                        (handle) => handle.supportsSocketDelivery !== false
                            && handle.isDeliveryActive?.() !== false,
                    ).token;
                },
                sessionId: params.sessionId,
                persistenceContext: params.persistenceContext,
                initialRegisteredSessionStateFieldMutations: params.initialRegisteredSessionStateFieldMutations,
                flushOnReady: params.flushOnReady,
                runtimeActivitySupportControlled: params.runtimeActivitySupportControlled,
                getSocket: () => selectActiveGenericSessionClientDurableMutationOutboxHandle(
                    handles,
                    (handle) => handle.supportsSocketDelivery !== false
                        && handle.isDeliveryActive?.() !== false,
                ).getSocket(),
                requestReconnect: (reason) => {
                    for (const handle of handles.values()) {
                        if (handle.isDeliveryActive?.() === false) continue;
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
                isShuttingDown: () => [...handles.values()]
                    .some((handle) => handle.isShuttingDown?.() === true),
                deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                    const deliver = [...handles.values()]
                        .reverse()
                        .find((handle) => handle.isDeliveryActive?.() !== false
                            && handle.deliverRegisteredSessionStateFieldMutation !== undefined)
                        ?.deliverRegisteredSessionStateFieldMutation;
                    return deliver
                        ? await deliver(mutation)
                        : { delivered: false, unsupportedCapability: true };
                },
            }),
        };
        sharedGenericSessionClientDurableMutationOutboxes.set(outboxPath, shared);
    }

    const sharedEntry = shared;
    const handleId = Symbol(params.sessionId);
    let handleClosed = false;
    sharedEntry.handles.set(handleId, params);

    const closeHandle = async (): Promise<void> => {
        if (handleClosed) return;
        handleClosed = true;
        const current = sharedGenericSessionClientDurableMutationOutboxes.get(outboxPath);
        if (!current) return;
        current.handles.delete(handleId);
        if (current.handles.size > 0) return;
        sharedGenericSessionClientDurableMutationOutboxes.delete(outboxPath);
        const closingCurrent = current.outbox.close().finally(() => {
            if (closingGenericSessionClientDurableMutationOutboxes.get(outboxPath) === closingCurrent) {
                closingGenericSessionClientDurableMutationOutboxes.delete(outboxPath);
            }
        });
        closingGenericSessionClientDurableMutationOutboxes.set(outboxPath, closingCurrent);
        await closingCurrent;
    };

    return {
        enqueueSessionTurnMutation: async (mutation) => {
            if (handleClosed) return;
            await sharedEntry.outbox.enqueueSessionTurnMutation(mutation);
        },
        enqueueTranscriptMessage: async (mutation) => {
            if (handleClosed) return { persisted: false, delivered: false };
            return await sharedEntry.outbox.enqueueTranscriptMessage(mutation);
        },
        enqueueVoiceAgentTranscriptTurn: async (mutation) => {
            if (handleClosed) return { persisted: false, delivered: false };
            return await sharedEntry.outbox.enqueueVoiceAgentTranscriptTurn(mutation);
        },
        enqueueRegisteredSessionStateFieldMutation: async (mutation) => {
            if (handleClosed) return;
            await sharedEntry.outbox.enqueueRegisteredSessionStateFieldMutation(mutation);
        },
        enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery: async (mutation, opts) => {
            if (handleClosed) return { status: 'failed' };
            return await sharedEntry.outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(mutation, opts);
        },
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

export type RuntimeSessionTurnMutationV1 = Exclude<SessionTurnMutationV1, Readonly<{ action: 'end_session' }>>;

export type RuntimeSessionClientDurableMutationOutbox = Readonly<{
    enqueueSessionTurnMutation(mutation: RuntimeSessionTurnMutationV1): Promise<void>;
    enqueueTranscriptMessage(mutation: TranscriptMessageAppendMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueVoiceAgentTranscriptTurn(mutation: VoiceAgentTranscriptTurnMutationV1): Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueRegisteredSessionStateFieldMutation(mutation: RegisteredSessionStateFieldMutationV1): Promise<void>;
    enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
        mutation: RegisteredSessionStateFieldMutationV1,
        opts?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<RegisteredSessionStateFieldWaitResult>;
    activateDelivery(): Promise<void>;
    deactivateDelivery(): void;
    setSessionSyncPendingInputServerContract(result: SessionSyncPendingInputServerContractResult): Promise<void>;
    readRuntimeActivitySnapshotTail(): RuntimeActivitySnapshotTail;
    waitForRuntimeActivitySnapshotTailChange(sequence: number, signal?: AbortSignal): Promise<boolean>;
    awaitReady(): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

export function createRuntimeSessionClientDurableMutationOutbox(params: Readonly<{
    token: string;
    sessionId: string;
    initialRegisteredSessionStateFieldMutations?: readonly RegisteredSessionStateFieldMutationV1[];
    flushOnReady?: boolean;
    initiallyActive?: boolean;
    getSocket: () => SessionClientDurableMutationSocket | null;
    requestReconnect: (reason: string) => void;
    deliverRegisteredSessionStateFieldMutation?: (
        mutation: RegisteredSessionStateFieldMutationV1,
    ) => Promise<boolean | Readonly<{
        delivered: boolean;
        settlement: 'applied' | 'superseded' | RegisteredSessionStateFieldAppliedSettlement;
    }> | Readonly<{ delivered: false; unsupportedCapability: true }>>;
}>): RuntimeSessionClientDurableMutationOutbox {
    let deliveryActive = params.initiallyActive !== false;
    let retainedSessionSyncPendingInputServerContract:
        SessionSyncPendingInputServerContractResult | null = null;
    const assertRuntimeCustodyMutation = (queued: QueuedSessionClientDurableMutation): void => {
        if (parseRuntimeSessionClientDurableMutation(queued, params.sessionId).mutations.length !== 1) {
            throw new Error('Mutation is not admitted by runtime custody for the expected session');
        }
    };
    for (const mutation of params.initialRegisteredSessionStateFieldMutations ?? []) {
        assertRuntimeCustodyMutation(createQueuedRegisteredSessionStateFieldMutation(mutation));
    }
    const persistenceContext = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir,
        custody: 'runtime',
        sessionId: params.sessionId,
        parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
    });
    const journal = createGenericSessionClientDurableMutationOutbox({
        ...params,
        persistenceContext,
        isDeliveryActive: () => deliveryActive,
        runtimeActivitySupportControlled: true,
    });
    return {
        async enqueueSessionTurnMutation(mutation) {
            const queued = createQueuedSessionTurnMutation(mutation as SessionTurnMutationV1);
            if (queued.payload.action === 'end_session') {
                throw new Error('Runtime mutation custody accepts only a normal turn for the expected session');
            }
            assertRuntimeCustodyMutation(queued);
            await journal.enqueueSessionTurnMutation(mutation as SessionTurnMutationV1);
        },
        async enqueueTranscriptMessage(mutation) {
            assertRuntimeCustodyMutation(createQueuedTranscriptMessage(mutation));
            return await journal.enqueueTranscriptMessage(mutation);
        },
        async enqueueVoiceAgentTranscriptTurn(mutation) {
            assertRuntimeCustodyMutation(createQueuedVoiceAgentTranscriptTurn(mutation));
            return await journal.enqueueVoiceAgentTranscriptTurn(mutation);
        },
        async enqueueRegisteredSessionStateFieldMutation(mutation) {
            assertRuntimeCustodyMutation(createQueuedRegisteredSessionStateFieldMutation(mutation));
            await journal.enqueueRegisteredSessionStateFieldMutation(mutation);
        },
        async enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(mutation, opts) {
            assertRuntimeCustodyMutation(createQueuedRegisteredSessionStateFieldMutation(mutation));
            return await journal.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(mutation, opts);
        },
        activateDelivery: async () => {
            deliveryActive = true;
            if (retainedSessionSyncPendingInputServerContract) {
                await journal.setSessionSyncPendingInputServerContract(
                    retainedSessionSyncPendingInputServerContract,
                );
            }
            await journal.flush('flush');
        },
        deactivateDelivery: () => {
            deliveryActive = false;
        },
        async setSessionSyncPendingInputServerContract(result) {
            retainedSessionSyncPendingInputServerContract = result;
            if (!deliveryActive) return;
            await journal.setSessionSyncPendingInputServerContract(result);
        },
        readRuntimeActivitySnapshotTail: () => journal.readRuntimeActivitySnapshotTail(),
        waitForRuntimeActivitySnapshotTailChange: (sequence, signal) => (
            journal.waitForRuntimeActivitySnapshotTailChange(sequence, signal)
        ),
        awaitReady: () => journal.awaitReady(),
        flush: (reason) => journal.flush(reason),
        close: () => journal.close(),
    };
}

export type ExactDaemonSessionTurnEndMutationV1 = ExactSessionTurnEndMutationV1;

export type DaemonSessionClientDurableMutationOutbox = Readonly<{
    enqueueExactTurnEnd(mutation: ExactDaemonSessionTurnEndMutationV1): Promise<void>;
    enqueueUsageLimitRecovery(mutation: DaemonUsageLimitRecoveryFieldMutation): Promise<void>;
    awaitReady(): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

export function createDaemonSessionClientDurableMutationOutbox(params: Readonly<{
    token: string;
    sessionId: string;
    getSocket: () => SessionClientDurableMutationSocket | null;
    requestReconnect: (reason: string) => void;
    deliverUsageLimitRecovery?: (
        mutation: DaemonUsageLimitRecoveryFieldMutation,
    ) => Promise<boolean | Readonly<{ delivered: boolean; settlement: 'applied' | 'superseded' }>>;
    enableExactTurnDelivery?: boolean;
    isShuttingDown?: () => boolean;
}>): DaemonSessionClientDurableMutationOutbox {
    const deliverUsageLimitRecovery = params.deliverUsageLimitRecovery;
    const persistenceContext = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir,
        custody: 'daemon',
        sessionId: params.sessionId,
        parseQueuedMutation: parseDaemonSessionClientDurableMutation,
    });
    const journal = createGenericSessionClientDurableMutationOutbox({
        ...params,
        persistenceContext,
        flushOnReady: false,
        supportsSocketDelivery: params.enableExactTurnDelivery
            ?? params.deliverUsageLimitRecovery === undefined,
        ...(deliverUsageLimitRecovery
            ? {
                deliverRegisteredSessionStateFieldMutation: async (mutation: RegisteredSessionStateFieldMutationV1) => {
                    if (
                        mutation.fieldId !== 'runtime.usageLimitRecovery'
                        || mutation.source !== 'daemon'
                        || mutation.deliveryClass !== 'durable_required'
                    ) {
                        return false;
                    }
                    return await deliverUsageLimitRecovery(
                        mutation as DaemonUsageLimitRecoveryFieldMutation,
                    );
                },
            }
            : {}),
    });
    return {
        async enqueueExactTurnEnd(mutation) {
            const queued = createQueuedSessionTurnMutation(mutation as SessionTurnMutationV1);
            if (parseDaemonSessionClientDurableMutation(queued, params.sessionId).mutations.length !== 1) {
                throw new Error('Daemon mutation custody accepts only an exact end for the expected session turn');
            }
            await journal.enqueueSessionTurnMutation(mutation as SessionTurnMutationV1);
        },
        async enqueueUsageLimitRecovery(mutation) {
            const queued = createQueuedRegisteredSessionStateFieldMutation(mutation);
            if (parseDaemonSessionClientDurableMutation(queued, params.sessionId).mutations.length !== 1) {
                throw new Error('Daemon mutation custody accepts only daemon-authored usage-limit recovery fields');
            }
            await journal.enqueueRegisteredSessionStateFieldMutation(mutation);
        },
        awaitReady: () => journal.awaitReady(),
        flush: (reason) => journal.flush(reason),
        close: () => journal.close(),
    };
}

function createGenericSessionClientDurableMutationOutboxInstance(
    params: CreateGenericSessionClientDurableMutationOutboxParams,
): GenericSessionClientDurableMutationOutboxInstance {
    let closed = false;
    let mutations: QueuedSessionClientDurableMutation[] = [];
    let inFlightMutations: QueuedSessionClientDurableMutation[] = [];
    let flushInFlight: Promise<void> | null = null;
    let persistInFlight: Promise<void> = Promise.resolve();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let loadedMutationsNeedPersist = false;
    // Set only when already-observed transcript output remains resident after its admission save failed.
    let mutationsNeedPersistBeforeDelivery = false;
    let durableFailedMutationReasons = new Map<string, string>();
    let nextRegisteredFieldAdmissionOrder: number | null = 1;
    const registeredFieldSettlements = new Map<string, RegisteredFieldSettlementGroup>();
    let deadLetterRecoveryTail: Promise<void> = Promise.resolve();
    let sessionSyncPendingInputServerContractResult: SessionSyncPendingInputServerContractResult | null = null;
    let runtimeActivityTail: RuntimeActivitySnapshotTail = {
        sequence: 0,
        custody: null,
        settlement: null,
    };
    const runtimeActivityTailWaiters = new Set<() => void>();

    function publishRuntimeActivityTail(next: Omit<RuntimeActivitySnapshotTail, 'sequence'>): void {
        runtimeActivityTail = {
            sequence: Math.min(Number.MAX_SAFE_INTEGER, runtimeActivityTail.sequence + 1),
            ...next,
        };
        for (const resolve of runtimeActivityTailWaiters) resolve();
        runtimeActivityTailWaiters.clear();
    }

    function readQueuedRuntimeActivityCustody(): RuntimeActivitySnapshotTail['custody'] {
        const activity = mutations.find((mutation) => (
            mutation.kind === 'registered_session_state_field'
            && mutation.payload.fieldId === 'runtime.activity'
        ));
        return activity ? readRuntimeActivityCustody(activity) : null;
    }

    function publishQueuedRuntimeActivityCustodyIfChanged(): void {
        const custody = readQueuedRuntimeActivityCustody();
        if (custody === null) return;
        const current = runtimeActivityTail.custody;
        if (
            current?.identity.mutationKey === custody.identity.mutationKey
            && current.identity.admissionOrder === custody.identity.admissionOrder
            && current.value.state === custody.value.state
            && current.value.activeCount === custody.value.activeCount
        ) return;
        publishRuntimeActivityTail({ custody, settlement: null });
    }

    function allocateRegisteredFieldAdmissionOrder(): number {
        const admissionOrder = nextRegisteredFieldAdmissionOrder;
        if (admissionOrder === null) {
            throw new RangeError('Registered session-state field admission order exhausted');
        }
        nextRegisteredFieldAdmissionOrder = admissionOrder >= Number.MAX_SAFE_INTEGER
            ? null
            : admissionOrder + 1;
        return admissionOrder;
    }

    function assignRegisteredFieldAdmissionOrder(
        mutation: QueuedSessionClientDurableMutation,
    ): QueuedSessionClientDurableMutation {
        if (mutation.kind !== 'registered_session_state_field') return mutation;
        const existing = readRegisteredFieldAdmissionOrder(mutation);
        if (existing !== null) return mutation;
        return {
            ...mutation,
            admissionOrder: allocateRegisteredFieldAdmissionOrder(),
        };
    }

    function isRegisteredFieldMutationForField(
        mutation: QueuedSessionClientDurableMutation,
        fieldId: string,
    ): boolean {
        return mutation.kind === 'registered_session_state_field'
            && mutation.payload.fieldId === fieldId;
    }


    async function recoverDeadLetteredAuthoritativeMutations(): Promise<void> {
        const recover = async (): Promise<void> => {
            const recoveredRows = await recoverAuthoritativeSessionClientDurableMutationDeadLetters(
                params.sessionId,
                100,
                params.persistenceContext,
            );
            if (recoveredRows.length === 0) return;
            const admittedRecovered = recoveredRows
                .map(normalizeQueuedRuntimeActivityIdentity)
                .map(assignRegisteredFieldAdmissionOrder);
            const previousPersist = persistInFlight;
            const nextPersist = previousPersist
                .catch(() => undefined)
                .then(async () => {
                    const queuedMerge = mergeQueuedSessionClientDurableMutationsWithOwnership(mutations, admittedRecovered);
                    const committedMerge = mergeQueuedSessionClientDurableMutationsWithOwnership(
                        inFlightMutations,
                        queuedMerge.mutations,
                    );
                    const committed = pruneSessionEndsSupersededByLaterTurnBegins(committedMerge.mutations);
                    await saveSessionClientDurableMutationOutbox(params.sessionId, committed, params.persistenceContext);
                    applyRegisteredFieldOwnershipReplacements(queuedMerge.replacements);
                    applyRegisteredFieldOwnershipReplacements(committedMerge.replacements);
                    const committedQueued = queuedMerge.mutations.filter((candidate) => committed.includes(candidate));
                    mutations = mergeLiveQueuedMutations(mutations, committedQueued);
                    publishQueuedRuntimeActivityCustodyIfChanged();
                    loadedMutationsNeedPersist = false;
                });
            persistInFlight = nextPersist;
            await nextPersist;
            await markAuthoritativeSessionClientDurableMutationDeadLettersRecovered(
                params.sessionId,
                recoveredRows.map((mutation) => mutation.mutationId),
                params.persistenceContext,
            );
            logger.debug('[API] Re-queued authoritative durable session mutations from dead letters', {
                sessionId: params.sessionId,
                recoveredCount: recoveredRows.length,
            });
        };
        const recovery = deadLetterRecoveryTail.then(recover, recover);
        deadLetterRecoveryTail = recovery.catch(() => undefined);
        await recovery;
    }

    const ready = (async () => {
        const loadedRaw = await loadSessionClientDurableMutationOutbox(params.sessionId, params.persistenceContext);
        const recoveredRaw = await recoverAuthoritativeSessionClientDurableMutationDeadLetters(
            params.sessionId,
            100,
            params.persistenceContext,
        );
        const loaded = loadedRaw.map(normalizeQueuedRuntimeActivityIdentity);
        const recovered = recoveredRaw.map(normalizeQueuedRuntimeActivityIdentity);
        const hydrated = pruneSessionEndsSupersededByLaterTurnBegins(
            mergeQueuedSessionClientDurableMutations(loaded, recovered),
        );
        const highestPersistedAdmissionOrder = hydrated.reduce((highest, mutation) => (
            Math.max(highest, readRegisteredFieldAdmissionOrder(mutation) ?? 0)
        ), 0);
        nextRegisteredFieldAdmissionOrder = highestPersistedAdmissionOrder >= Number.MAX_SAFE_INTEGER
            ? null
            : highestPersistedAdmissionOrder + 1;
        mutations = hydrated.map(assignRegisteredFieldAdmissionOrder);
        const assignedHydratedAdmissionOrder = mutations.some((mutation, index) => mutation !== hydrated[index]);
        let initialSnapshotChangedQueue = false;
        for (const initialMutation of params.initialRegisteredSessionStateFieldMutations ?? []) {
            if (initialMutation.sessionId !== params.sessionId) {
                throw new Error('Initial registered session-state field mutation belongs to a different session');
            }
            const withoutPersistedField = mutations.filter((queued) => (
                !isRegisteredFieldMutationForField(queued, initialMutation.fieldId)
            ));
            mutations = mergeQueuedSessionClientDurableMutations(
                withoutPersistedField,
                [assignRegisteredFieldAdmissionOrder(createQueuedRegisteredSessionStateFieldMutation(initialMutation))],
            );
            initialSnapshotChangedQueue = true;
        }
        loadedMutationsNeedPersist = recovered.length > 0
            || mutations.length !== loadedRaw.length
            || loaded.some((mutation, index) => mutation !== loadedRaw[index])
            || assignedHydratedAdmissionOrder
            || initialSnapshotChangedQueue;
        if (loadedMutationsNeedPersist) {
            await persist();
            loadedMutationsNeedPersist = false;
        }
        if (recovered.length > 0) {
            await markAuthoritativeSessionClientDurableMutationDeadLettersRecovered(
                params.sessionId,
                recovered.map((mutation) => mutation.mutationId),
                params.persistenceContext,
            );
            logger.debug('[API] Re-queued authoritative durable session mutations from dead letters', {
                sessionId: params.sessionId,
                recoveredCount: recovered.length,
            });
        }
        const deadLetters = await loadSessionClientDurableMutationDeadLetters(params.sessionId, params.persistenceContext);
        durableFailedMutationReasons = createDurableFailedMutationReasons(deadLetters);
        const hydratedRuntimeActivityCustody = readQueuedRuntimeActivityCustody();
        if (hydratedRuntimeActivityCustody !== null) {
            runtimeActivityTail = {
                sequence: 1,
                custody: hydratedRuntimeActivityCustody,
                settlement: null,
            };
        }
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
            throw error;
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
                        mergeQueuedSessionClientDurableMutations(
                            inFlightMutations,
                            mutations,
                        ),
                    ),
                    params.persistenceContext,
                );
            });
        persistInFlight = nextPersist;
        await nextPersist;
    }

    function settleRegisteredFieldGroup(
        group: RegisteredFieldSettlementGroup,
        status: RegisteredFieldSettlementStatus,
    ): void {
        if (group.completed) return;
        group.completed = true;
        group.settled = status;
        for (const waiter of group.waiters) waiter.resolve(status);
        group.waiters.clear();
        for (const [mutationId, candidate] of registeredFieldSettlements) {
            if (candidate === group) registeredFieldSettlements.delete(mutationId);
        }
    }

    function rejectRegisteredFieldGroup(
        group: RegisteredFieldSettlementGroup,
        error: unknown,
    ): void {
        if (group.completed) return;
        group.completed = true;
        group.error = error;
        for (const waiter of group.waiters) waiter.reject(error);
        group.waiters.clear();
        for (const [mutationId, candidate] of registeredFieldSettlements) {
            if (candidate === group) registeredFieldSettlements.delete(mutationId);
        }
    }

    function transferRegisteredFieldSettlementGroup(params: Readonly<{
        supersededMutationId: string;
        survivingMutationId: string;
    }>): void {
        if (params.supersededMutationId === params.survivingMutationId) return;
        const superseded = registeredFieldSettlements.get(params.supersededMutationId);
        const surviving = registeredFieldSettlements.get(params.survivingMutationId);
        if (!superseded && !surviving) return;
        const target = surviving ?? superseded;
        if (!target) return;
        if (superseded && surviving && superseded !== surviving) {
            for (const waiter of superseded.waiters) surviving.waiters.add(waiter);
            if (superseded.settled) settleRegisteredFieldGroup(surviving, superseded.settled);
        }
        target.activeMutationId = params.survivingMutationId;
        for (const [mutationId, candidate] of registeredFieldSettlements) {
            if (candidate === superseded || candidate === surviving) {
                registeredFieldSettlements.set(mutationId, target);
            }
        }
        registeredFieldSettlements.set(params.supersededMutationId, target);
        registeredFieldSettlements.set(params.survivingMutationId, target);
    }

    function applyRegisteredFieldOwnershipReplacements(
        replacements: readonly QueuedMutationOwnershipReplacement[],
    ): void {
        for (const replacement of replacements) {
            transferRegisteredFieldSettlementGroup(replacement);
        }
    }

    function mergeLiveQueuedMutations(
        earlier: readonly QueuedSessionClientDurableMutation[],
        later: readonly QueuedSessionClientDurableMutation[],
    ): QueuedSessionClientDurableMutation[] {
        const result = mergeQueuedSessionClientDurableMutationsWithOwnership(earlier, later);
        applyRegisteredFieldOwnershipReplacements(result.replacements);
        return result.mutations;
    }

    function registerRegisteredFieldWaiter(
        mutationId: string,
        signal?: AbortSignal,
    ): Readonly<{
        group: RegisteredFieldSettlementGroup;
        promise: Promise<RegisteredFieldSettlementStatus | 'cancelled'>;
        rejectAdmission(error: unknown): void;
    }> {
        const group = registeredFieldSettlements.get(mutationId) ?? {
            activeMutationId: mutationId,
            activeAdmissionOrder: null,
            completed: false,
            error: null,
            settled: null,
            waiters: new Set<RegisteredFieldWaiter>(),
        };
        registeredFieldSettlements.set(mutationId, group);
        let admissionWaiter: RegisteredFieldWaiter | null = null;
        const promise = new Promise<RegisteredFieldSettlementStatus | 'cancelled'>((resolve, reject) => {
            if (group.completed) {
                if (group.settled) resolve(group.settled);
                else reject(group.error);
                return;
            }
            if (signal?.aborted) {
                resolve('cancelled');
                return;
            }
            let waiter: RegisteredFieldWaiter;
            const detach = (): void => {
                group.waiters.delete(waiter);
                signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = (): void => {
                detach();
                resolve('cancelled');
            };
            waiter = {
                resolve: (status) => {
                    detach();
                    resolve(status);
                },
                reject: (error) => {
                    detach();
                    reject(error);
                },
            };
            group.waiters.add(waiter);
            admissionWaiter = waiter;
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        void promise.catch(() => undefined);
        return {
            group,
            promise,
            rejectAdmission(error) {
                admissionWaiter?.reject(error);
                if (
                    group.activeAdmissionOrder === null
                    && group.waiters.size === 0
                    && registeredFieldSettlements.get(mutationId) === group
                ) {
                    registeredFieldSettlements.delete(mutationId);
                }
            },
        };
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
            if (isTranscriptDeliveryMutation(mutation)) {
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
            if (params.isShuttingDown?.() === true) return;
            void flush('timer').catch((error) => {
                logger.debug('[API] Durable session mutation retry flush failed', {
                    sessionId: params.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
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
                serverContractMode: sessionSyncPendingInputServerContractResult?.mode,
                mutation: mutation.payload,
            });
            return { delivered: result.delivered };
        }
        if (mutation.kind === 'voice_agent_transcript_turn') {
            const user = await deliverTranscriptMessageMutation({
                token: params.token,
                socket: params.getSocket(),
                serverContractMode: sessionSyncPendingInputServerContractResult?.mode,
                mutation: mutation.payload.user,
            });
            if (!user.delivered) return { delivered: false };
            const assistant = await deliverTranscriptMessageMutation({
                token: params.token,
                socket: params.getSocket(),
                serverContractMode: sessionSyncPendingInputServerContractResult?.mode,
                mutation: mutation.payload.assistant,
            });
            return { delivered: assistant.delivered };
        }
        if (mutation.kind === 'registered_session_state_field') {
            if (!params.deliverRegisteredSessionStateFieldMutation) {
                return { delivered: false, unsupportedCapability: true };
            }
            const result = await params.deliverRegisteredSessionStateFieldMutation(mutation.payload);
            if (typeof result === 'boolean') {
                return mutation.payload.fieldId === 'runtime.activity'
                    ? { delivered: false }
                    : { delivered: result };
            }
            if ('unsupportedCapability' in result && result.unsupportedCapability) {
                return { delivered: false, unsupportedCapability: true };
            }
            if (result.delivered) {
                const runtimeActivitySettlement = mutation.payload.fieldId === 'runtime.activity'
                    ? readRuntimeActivitySettlement(mutation, result.settlement)
                    : undefined;
                if (mutation.payload.fieldId === 'runtime.activity' && !runtimeActivitySettlement) {
                    return { delivered: false };
                }
                const settlementGroup = registeredFieldSettlements.get(mutation.mutationId);
                const admissionOrder = readRegisteredFieldAdmissionOrder(mutation);
                if (
                    admissionOrder !== null
                    && settlementGroup?.activeMutationId === mutation.mutationId
                    && settlementGroup.activeAdmissionOrder === admissionOrder
                ) {
                    return {
                        delivered: true,
                        ...(runtimeActivitySettlement ? { runtimeActivitySettlement } : {}),
                        registeredFieldSettlement: {
                            mutationId: mutation.mutationId,
                            admissionOrder,
                            group: settlementGroup,
                            status: result.settlement,
                        },
                    };
                }
                return {
                    delivered: true,
                    ...(runtimeActivitySettlement ? { runtimeActivitySettlement } : {}),
                };
            }
            return { delivered: result.delivered };
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
        if (closed && reason !== 'flush') return;
        await recoverDeadLetteredAuthoritativeMutations().catch((error) => {
            logger.debug('[API] Failed to recover dead-lettered authoritative durable session mutations', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        await persistInFlight.catch(() => undefined);
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
            const batchMutationIds = new Set(
                batch.map((mutation) => mutation.mutationId),
            );
            const capabilityBlockedKeys = new Set<string>();
            const mutationsPendingDurableRemoval: QueuedSessionClientDurableMutation[] = [];
            const registeredFieldSettlementsPendingDurableCut: PendingRegisteredFieldSettlement[] = [];
            let runtimeActivitySettlementPendingDurableCut: RuntimeActivitySnapshotTail['settlement'] = null;
            let runtimeActivityRetirementPendingDurableCut: number | null = null;
            const transcriptFlushBatchLimit = reason === 'flush'
                ? Number.POSITIVE_INFINITY
                : resolveSessionClientDurableMutationTranscriptFlushBatchLimit();
            let transcriptDeliveriesThisFlush = 0;
            const refreshInFlightMutations = (nextIndex: number): void => {
                inFlightMutations = mergeLiveQueuedMutations(
                    remaining,
                    batch.slice(nextIndex),
                );
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
                if (mutation.kind === 'registered_session_state_field' && mutation.payload.fieldId === 'runtime.activity') {
                    const contractMode = sessionSyncPendingInputServerContractResult?.mode ?? 'indeterminate';
                    if (
                        params.runtimeActivitySupportControlled
                        && contractMode !== 'session_sync_v2_pending_input_v1'
                        && contractMode !== 'released_server_v0_2_1'
                    ) {
                        remaining.push(mutation);
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                    if (
                        params.runtimeActivitySupportControlled
                        && contractMode === 'released_server_v0_2_1'
                    ) {
                        const settlementGroup = registeredFieldSettlements.get(mutation.mutationId);
                        mutationsPendingDurableRemoval.push(mutation);
                        const admissionOrder = readRegisteredFieldAdmissionOrder(mutation);
                        runtimeActivityRetirementPendingDurableCut = admissionOrder;
                        if (
                            admissionOrder !== null
                            && settlementGroup?.activeMutationId === mutation.mutationId
                            && settlementGroup.activeAdmissionOrder === admissionOrder
                        ) {
                            registeredFieldSettlementsPendingDurableCut.push({
                                mutationId: mutation.mutationId,
                                admissionOrder,
                                group: settlementGroup,
                                status: 'failed',
                            });
                        }
                        didChange = true;
                        refreshInFlightMutations(index + 1);
                        continue;
                    }
                }
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
                if (capabilityBlockedKeys.has(readCapabilityBlockKey(mutation))) {
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
                    if (isTranscriptDeliveryMutation(mutation) || (
                        mutation.kind === 'registered_session_state_field'
                        && mutation.payload.fieldId === 'runtime.activity'
                    )) {
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
                    && isTranscriptDeliveryMutation(mutation)
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
                if (isTranscriptDeliveryMutation(mutation)) {
                    transcriptDeliveriesThisFlush += 1;
                }
                let outcome: DurableMutationDeliveryOutcome = { delivered: false };
                try {
                    outcome = await withSessionClientDurableMutationDeliverySlot(() => deliver(mutation));
                    if (outcome.delivered) {
                        mutationsPendingDurableRemoval.push(mutation);
                        if (outcome.registeredFieldSettlement) {
                            registeredFieldSettlementsPendingDurableCut.push(outcome.registeredFieldSettlement);
                        }
                        if (outcome.runtimeActivitySettlement) {
                            runtimeActivitySettlementPendingDurableCut = outcome.runtimeActivitySettlement;
                        }
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
                    capabilityBlockedKeys.add(readCapabilityBlockKey(mutation));
                    remaining.push({
                        ...mutation,
                        nextAttemptAt: Date.now() + resolveSessionClientDurableMutationRetryDelayMs(0),
                    } as QueuedSessionClientDurableMutation);
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
                }

                if (mutation.kind === 'registered_session_state_field' && mutation.payload.fieldId === 'runtime.activity') {
                    const attempts = mutation.attempts + 1;
                    remaining.push({
                        ...mutation,
                        attempts,
                        nextAttemptAt: Date.now() + resolveSessionClientDurableMutationRetryDelayMs(attempts),
                    } as QueuedSessionClientDurableMutation);
                    refreshInFlightMutations(index + 1);
                    didChange = true;
                    continue;
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
            mutations = mergeLiveQueuedMutations(
                remaining,
                mutations,
            );
            inFlightMutations = [];
            pruneDurableFailedMutationReasonsForQueuedDependents(reason);
            if (didChange) {
                try {
                    await persist();
                } catch (error) {
                    const now = Date.now();
                    mutations = mergeLiveQueuedMutations(
                        mutationsPendingDurableRemoval.map((mutation) => {
                            const attempts = mutation.attempts + 1;
                            return {
                                ...mutation,
                                attempts,
                                nextAttemptAt: now + resolveSessionClientDurableMutationRetryDelayMs(attempts),
                            } as QueuedSessionClientDurableMutation;
                        }),
                        mutations,
                    );
                    scheduleRetry();
                    throw error;
                }
                for (const pendingSettlement of registeredFieldSettlementsPendingDurableCut) {
                    if (
                        pendingSettlement.group.activeMutationId === pendingSettlement.mutationId
                        && pendingSettlement.group.activeAdmissionOrder === pendingSettlement.admissionOrder
                    ) {
                        settleRegisteredFieldGroup(pendingSettlement.group, pendingSettlement.status);
                    }
                }
                if (
                    runtimeActivitySettlementPendingDurableCut
                    && runtimeActivityTail.custody?.identity.admissionOrder
                        === runtimeActivitySettlementPendingDurableCut.identity.admissionOrder
                ) {
                    publishRuntimeActivityTail({
                        custody: null,
                        settlement: runtimeActivitySettlementPendingDurableCut,
                    });
                } else if (
                    runtimeActivityRetirementPendingDurableCut !== null
                    && runtimeActivityTail.custody?.identity.admissionOrder
                        === runtimeActivityRetirementPendingDurableCut
                ) {
                    publishRuntimeActivityTail({ custody: null, settlement: null });
                }
                const retention = await appendSessionClientDurableMutationDeadLetters(
                    params.sessionId,
                    deadLetters,
                    params.persistenceContext,
                );
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
            const hasDeliverableMutation = mutations.some((mutation) => !(
                mutation.kind === 'registered_session_state_field'
                && mutation.payload.fieldId === 'runtime.activity'
                && params.runtimeActivitySupportControlled
                && sessionSyncPendingInputServerContractResult?.mode !== 'session_sync_v2_pending_input_v1'
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
            || inFlightMutations.some((queued) => queued.mutationId === mutationId)
        );
    }

    async function enqueue(
        mutation: QueuedSessionClientDurableMutation,
        opts: Readonly<{
            awaitFlush?: boolean;
            registeredFieldSettlementGroup?: RegisteredFieldSettlementGroup;
            rejectRegisteredFieldAdmission?: (error: unknown) => void;
        }> = {},
    ): Promise<Readonly<{ delivered: boolean; persisted: boolean }>> {
        await ready;
        if (closed) return { delivered: false, persisted: false };
        let admittedMutation = mutation;
        let reusedDurableCustody = false;
        const previousPersist = persistInFlight;
        const nextPersist = previousPersist
            .catch(() => undefined)
            .then(async () => {
                if (closed) return;
                assertTranscriptCoalescingCompatible(mutation, mutations);
                assertTranscriptCoalescingCompatible(mutation, inFlightMutations);
                assertVoiceAgentTranscriptTurnCompatible(mutation, mutations);
                assertVoiceAgentTranscriptTurnCompatible(mutation, inFlightMutations);
                if (mutation.kind === 'registered_session_state_field') {
                    const existing = mergeQueuedSessionClientDurableMutations(
                        inFlightMutations,
                        mutations,
                    ).find((candidate) => (
                        readQueuedMutationCoalesceKey(candidate) === readQueuedMutationCoalesceKey(mutation)
                        && registeredFieldValuesEqual(candidate, mutation)
                    ));
                    if (existing) {
                        admittedMutation = existing;
                        reusedDurableCustody = true;
                        const settlementGroup = registeredFieldSettlements.get(mutation.mutationId);
                        if (settlementGroup) {
                            settlementGroup.activeAdmissionOrder = readRegisteredFieldAdmissionOrder(existing);
                        }
                        return;
                    }
                    const admissionOrder = nextRegisteredFieldAdmissionOrder;
                    if (admissionOrder === null) {
                        throw new RangeError('Registered session-state field admission order exhausted');
                    }
                    admittedMutation = {
                        ...mutation,
                        admissionOrder,
                    };
                }
                const queuedMerge = mergeQueuedSessionClientDurableMutationsWithOwnership(
                    mutations,
                    [admittedMutation],
                );
                const candidate = pruneSessionEndsSupersededByLaterTurnBegins(
                    queuedMerge.mutations,
                );
                const committedMerge = mergeQueuedSessionClientDurableMutationsWithOwnership(
                    inFlightMutations,
                    candidate,
                );
                const committed = pruneSessionEndsSupersededByLaterTurnBegins(committedMerge.mutations);
                await saveSessionClientDurableMutationOutbox(
                    params.sessionId,
                    committed,
                    params.persistenceContext,
                );
                mutationsNeedPersistBeforeDelivery = false;
                const admittedOrder = readRegisteredFieldAdmissionOrder(admittedMutation);
                if (admittedOrder !== null) {
                    nextRegisteredFieldAdmissionOrder = admittedOrder >= Number.MAX_SAFE_INTEGER
                        ? null
                        : admittedOrder + 1;
                    const settlementGroup = registeredFieldSettlements.get(admittedMutation.mutationId);
                    if (settlementGroup) {
                        settlementGroup.activeMutationId = admittedMutation.mutationId;
                        settlementGroup.activeAdmissionOrder = admittedOrder;
                    }
                }
                applyRegisteredFieldOwnershipReplacements(queuedMerge.replacements);
                applyRegisteredFieldOwnershipReplacements(committedMerge.replacements);
                const admittedSettlementGroup = registeredFieldSettlements.get(admittedMutation.mutationId);
                if (admittedOrder !== null && admittedSettlementGroup) {
                    admittedSettlementGroup.activeMutationId = admittedMutation.mutationId;
                    admittedSettlementGroup.activeAdmissionOrder = admittedOrder;
                }
                const committedQueued = candidate.filter((candidateMutation) => (
                    committed.includes(candidateMutation)
                ));
                const publicationMerge = mergeQueuedSessionClientDurableMutationsWithOwnership(
                    mutations,
                    committedQueued,
                );
                applyRegisteredFieldOwnershipReplacements(publicationMerge.replacements);
                mutations = pruneSessionEndsSupersededByLaterTurnBegins(publicationMerge.mutations);
                publishQueuedRuntimeActivityCustodyIfChanged();
            });
        persistInFlight = nextPersist;
        try {
            await nextPersist;
        } catch (error) {
            if (isTranscriptDeliveryMutation(admittedMutation)) {
                // Transcript delivery mutations describe provider output that has
                // already been observed. Retain the candidate in the canonical
                // in-process journal so the existing flush path can persist it
                // after storage recovers. Pre-effect admission mutations remain
                // unpublished and therefore fail closed before delivery.
                mutations = mergeLiveQueuedMutations(mutations, [admittedMutation]);
                mutationsNeedPersistBeforeDelivery = true;
            }
            const admissionError = new SessionMutationJournalAdmissionBlockedError(error);
            opts.rejectRegisteredFieldAdmission?.(admissionError);
            throw admissionError;
        }
        if (closed) return { delivered: false, persisted: false };
        const flushPromise = flush(reusedDurableCustody ? 'flush' : 'enqueue').catch((error) => {
            logger.debug('[API] Durable session mutation enqueue flush failed', {
                sessionId: params.sessionId,
                mutationKind: mutation.kind,
                mutationId: admittedMutation.mutationId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        if (opts.awaitFlush === true) {
            await flushPromise;
        } else {
            void flushPromise;
        }
        const deliveryMutationId = opts.registeredFieldSettlementGroup?.activeMutationId ?? admittedMutation.mutationId;
        return { delivered: !hasQueuedMutation(deliveryMutationId), persisted: true };
    }

    if (params.flushOnReady !== false) {
        void ready.then(() => {
            if (mutations.length > 0) {
                return flush('startup');
            }
            return undefined;
        }).catch(() => {});
    }

    return {
        async enqueueSessionTurnMutation(mutation) {
            await enqueue(createQueuedSessionTurnMutation(mutation));
        },
        async enqueueTranscriptMessage(mutation) {
            const result = await enqueue(createQueuedTranscriptMessage(mutation), { awaitFlush: true });
            return { persisted: result.persisted, delivered: result.delivered };
        },
        async enqueueVoiceAgentTranscriptTurn(mutation) {
            const result = await enqueue(createQueuedVoiceAgentTranscriptTurn(mutation));
            return { persisted: result.persisted, delivered: result.delivered };
        },
        async enqueueRegisteredSessionStateFieldMutation(mutation) {
            await enqueue(createQueuedRegisteredSessionStateFieldMutation(mutation));
        },
        async enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(mutation, opts) {
            const queued = createQueuedRegisteredSessionStateFieldMutation(mutation);
            const waiter = registerRegisteredFieldWaiter(queued.mutationId, opts?.signal);
            await enqueue(queued, {
                awaitFlush: true,
                registeredFieldSettlementGroup: waiter.group,
                rejectRegisteredFieldAdmission: waiter.rejectAdmission,
            });
            const settlement = await waiter.promise;
            return typeof settlement === 'string' ? { status: settlement } : settlement;
        },
        async setSessionSyncPendingInputServerContract(result) {
            await ready;
            if (closed) return;
            const previousMode = sessionSyncPendingInputServerContractResult?.mode;
            sessionSyncPendingInputServerContractResult = result;
            if (
                previousMode !== result.mode
                && (
                    result.mode === 'session_sync_v2_pending_input_v1'
                    || result.mode === 'released_server_v0_2_1'
                )
            ) await flush('flush');
        },
        readRuntimeActivitySnapshotTail() {
            return runtimeActivityTail;
        },
        async waitForRuntimeActivitySnapshotTailChange(sequence, signal) {
            await ready;
            if (runtimeActivityTail.sequence !== sequence) return true;
            if (signal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                let settled = false;
                const onChanged = (): void => finish(true);
                const onAbort = (): void => finish(false);
                const finish = (changed: boolean): void => {
                    if (settled) return;
                    settled = true;
                    runtimeActivityTailWaiters.delete(onChanged);
                    signal?.removeEventListener('abort', onAbort);
                    resolve(changed);
                };
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
            if (mutations.length > 0 || inFlightMutations.length > 0) {
                await persist();
            }
        },
    };
}
