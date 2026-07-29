import { randomUUID } from 'node:crypto';

import type {
    SessionMessageRole,
    SessionStateFieldDeliveryClassV1,
    SessionStateFieldId,
    SessionStoredMessageContent,
    SessionTurnMutationV1,
} from '@happier-dev/protocol';
import {
    SessionTranscriptObservationProvenanceV1Schema,
    type SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';

export type SessionClientDurableMutationDependency = Readonly<{
    mutationId: string;
    relationship: 'same_turn_prerequisite' | 'session_lifecycle_prerequisite';
}>;

export type SessionClientDurableMutationPause = Readonly<{
    reason:
        | 'session_auth_recovery'
        | 'runtime_auth_recovery'
        | 'setup_recovery'
        | 'user_paused_recovery';
    pausedAt: number;
    resumeAtMs?: number;
    diagnostic?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type SessionClientDurableMutationSocket = Readonly<{
    connected: boolean;
    emit(event: string, payload: unknown, callback?: (answer: unknown) => void): void;
    emitWithAck?(event: string, ...args: unknown[]): Promise<unknown>;
    timeout?(ms: number): SessionClientDurableMutationSocket;
}>;

export type SessionEndMutationV1 = Readonly<{
    v: 1;
    sessionId: string;
    mutationId: string;
    source: 'session_end';
    observedAt: number;
    exit?: unknown;
}>;

export type TranscriptMessageAppendMutationContentV1 =
    | string
    | SessionStoredMessageContent;

export type TranscriptMessageAppendMutationV1 = Readonly<{
    v: 1;
    sessionId: string;
    mutationId: string;
    source: 'transcript_message_append';
    localId: string;
    sidechainId?: string | null;
    messageRole?: SessionMessageRole;
    content: TranscriptMessageAppendMutationContentV1;
    createdAt: number;
    updatedAt: number;
    sessionEventType?: 'ready';
    provenance: SessionTranscriptObservationProvenanceV1;
}>;

/** Recovery-only shape for public-dev journals written before provenance became mandatory. */
export type PersistedTranscriptMessageAppendMutationV1 =
    | TranscriptMessageAppendMutationV1
    | Readonly<Omit<TranscriptMessageAppendMutationV1, 'provenance'> & {
        provenance?: undefined;
    }>;

export type VoiceAgentTranscriptTurnMutationV1 = Readonly<{
    v: 1;
    sessionId: string;
    mutationId: string;
    source: 'voice_agent_transcript_turn';
    /** Stable execution-run stream identity for the completed logical turn. */
    turnId: string;
    user: TranscriptMessageAppendMutationV1;
    assistant: TranscriptMessageAppendMutationV1;
    observedAt: number;
}>;

/** Recovery-only shape; canonical new voice turns always carry provenance on both roles. */
export type PersistedVoiceAgentTranscriptTurnMutationV1 = Readonly<
    Omit<VoiceAgentTranscriptTurnMutationV1, 'user' | 'assistant'> & {
        user: PersistedTranscriptMessageAppendMutationV1;
        assistant: PersistedTranscriptMessageAppendMutationV1;
    }
>;

export type RegisteredSessionStateFieldMutationV1 = Readonly<{
    v: 1;
    sessionId: string;
    mutationId: string;
    fieldId: SessionStateFieldId;
    deliveryClass: SessionStateFieldDeliveryClassV1;
    op: Readonly<{
        kind: 'set';
        value: unknown;
        valueFingerprint?: string;
    }> | Readonly<{
        kind: 'clear';
        previousFingerprint?: string;
    }>;
    source: 'runtime' | 'ui' | 'daemon' | 'server_reconcile' | 'compat';
    observedAt: number;
    dependsOn?: readonly SessionClientDurableMutationDependency[];
}>;

export type DaemonUsageLimitRecoveryFieldMutation = RegisteredSessionStateFieldMutationV1 & Readonly<{
    fieldId: 'runtime.usageLimitRecovery';
    source: 'daemon';
    deliveryClass: 'durable_required';
}>;

export type QueuedSessionClientDurableMutation =
    | Readonly<{
        kind: 'session_turn_mutation';
        mutationId: string;
        payload: SessionTurnMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
        dependsOn?: readonly SessionClientDurableMutationDependency[];
        paused?: SessionClientDurableMutationPause;
    }>
    | Readonly<{
        kind: 'session_end';
        mutationId: string;
        payload: SessionEndMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
        dependsOn?: readonly SessionClientDurableMutationDependency[];
        paused?: SessionClientDurableMutationPause;
    }>
    | Readonly<{
        kind: 'transcript_message_append';
        mutationId: string;
        payload: PersistedTranscriptMessageAppendMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
        dependsOn?: readonly SessionClientDurableMutationDependency[];
        paused?: SessionClientDurableMutationPause;
    }>
    | Readonly<{
        kind: 'voice_agent_transcript_turn';
        mutationId: string;
        payload: PersistedVoiceAgentTranscriptTurnMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
        dependsOn?: readonly SessionClientDurableMutationDependency[];
        paused?: SessionClientDurableMutationPause;
    }>
    | Readonly<{
        kind: 'registered_session_state_field';
        mutationId: string;
        payload: RegisteredSessionStateFieldMutationV1;
        /** Positive durable admission identity assigned by the generic journal. */
        admissionOrder?: number;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
        dependsOn?: readonly SessionClientDurableMutationDependency[];
        paused?: SessionClientDurableMutationPause;
    }>;

export function resolveTranscriptMessageAppendMutationId(params: Readonly<{
    sessionId: string;
    localId: string;
}>): string {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const localId = readRequiredOpaqueString(params.localId, 'localId');
    return `transcript:${sessionId}:${localId}`;
}

export function resolveVoiceAgentTranscriptTurnMutationId(params: Readonly<{
    sessionId: string;
    turnId: string;
}>): string {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const turnId = normalizeRequiredString(params.turnId, 'turnId');
    return `voice-agent-transcript-turn:${sessionId}:${turnId}`;
}

export function createTranscriptMessageAppendMutation(params: Readonly<{
    sessionId: string;
    localId: string;
    content: TranscriptMessageAppendMutationContentV1;
    sidechainId?: string | null;
    messageRole?: SessionMessageRole;
    sessionEventType?: 'ready';
    createdAt?: number;
    updatedAt?: number;
    provenance: SessionTranscriptObservationProvenanceV1;
}>): TranscriptMessageAppendMutationV1 {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const localId = readRequiredOpaqueString(params.localId, 'localId');
    const sidechainId = normalizeOptionalString(params.sidechainId);
    const createdAt = normalizeObservedAt(params.createdAt ?? Date.now());
    const updatedAt = normalizeObservedAt(params.updatedAt ?? createdAt);
    return {
        v: 1,
        sessionId,
        mutationId: resolveTranscriptMessageAppendMutationId({ sessionId, localId }),
        source: 'transcript_message_append',
        localId,
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(params.messageRole ? { messageRole: params.messageRole } : {}),
        content: params.content,
        createdAt,
        updatedAt: Math.max(createdAt, updatedAt),
        provenance: requireTranscriptMessageAppendProvenance(params.provenance),
        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
    };
}

export function createVoiceAgentTranscriptTurnMutation(params: Readonly<{
    sessionId: string;
    turnId: string;
    user: TranscriptMessageAppendMutationV1;
    assistant: TranscriptMessageAppendMutationV1;
    observedAt?: number;
}>): VoiceAgentTranscriptTurnMutationV1 {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const turnId = normalizeRequiredString(params.turnId, 'turnId');
    if (params.user.sessionId !== sessionId || params.assistant.sessionId !== sessionId) {
        throw new Error('Voice-agent transcript turn roles must belong to the same session');
    }
    if (params.user.messageRole !== 'user' || params.assistant.messageRole !== 'agent') {
        throw new Error('Voice-agent transcript turn requires one user role followed by one agent role');
    }
    if (params.user.localId === params.assistant.localId) {
        throw new Error('Voice-agent transcript turn role local ids must be distinct');
    }
    requireTranscriptMessageAppendProvenance(params.user.provenance);
    requireTranscriptMessageAppendProvenance(params.assistant.provenance);
    return {
        v: 1,
        sessionId,
        mutationId: resolveVoiceAgentTranscriptTurnMutationId({ sessionId, turnId }),
        source: 'voice_agent_transcript_turn',
        turnId,
        user: params.user,
        assistant: params.assistant,
        observedAt: normalizeObservedAt(params.observedAt ?? Math.max(
            params.user.updatedAt,
            params.assistant.updatedAt,
        )),
    };
}

export function requireTranscriptMessageAppendProvenance(
    value: unknown,
): SessionTranscriptObservationProvenanceV1 {
    const parsed = SessionTranscriptObservationProvenanceV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new Error('Transcript append mutation provenance is required');
    }
    return parsed.data;
}

export function createRegisteredSessionStateFieldMutation(params: Readonly<{
    sessionId: string;
    fieldId: SessionStateFieldId;
    op: RegisteredSessionStateFieldMutationV1['op'];
    source: RegisteredSessionStateFieldMutationV1['source'];
    deliveryClass?: RegisteredSessionStateFieldMutationV1['deliveryClass'];
    observedAt?: number;
    dependsOn?: readonly SessionClientDurableMutationDependency[];
}>): RegisteredSessionStateFieldMutationV1 {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    return {
        v: 1,
        sessionId,
        mutationId: params.fieldId === 'runtime.activity'
            ? resolveRuntimeActivitySnapshotMutationId(sessionId)
            : randomUUID(),
        fieldId: params.fieldId,
        deliveryClass: params.deliveryClass ?? 'durable_required',
        op: params.op,
        source: params.source,
        observedAt: normalizeObservedAt(params.observedAt ?? Date.now()),
        ...(params.dependsOn && params.dependsOn.length > 0 ? { dependsOn: normalizeDependencies(params.dependsOn) } : {}),
    };
}

export function resolveRuntimeActivitySnapshotMutationId(sessionId: string): string {
    return `runtime-activity-snapshot:${normalizeRequiredString(sessionId, 'sessionId')}`;
}

function normalizeDependencies(
    dependencies: readonly SessionClientDurableMutationDependency[],
): readonly SessionClientDurableMutationDependency[] {
    return dependencies.map((dependency) => ({
        mutationId: normalizeRequiredString(dependency.mutationId, 'dependency.mutationId'),
        relationship: dependency.relationship,
    }));
}

function normalizeObservedAt(value: number): number {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequiredString(value: string | null | undefined, name: string): string {
    const normalized = normalizeOptionalString(value);
    if (!normalized) throw new Error(`${name} is required`);
    return normalized;
}

function readRequiredOpaqueString(value: string | null | undefined, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
