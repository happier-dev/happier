import { randomUUID } from 'node:crypto';

import type {
    SessionMessageRole,
    SessionStateFieldDeliveryClassV1,
    SessionStateFieldId,
    SessionStoredMessageContent,
    SessionTurnMutationV1,
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
}>;

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
        payload: TranscriptMessageAppendMutationV1;
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
    const localId = normalizeRequiredString(params.localId, 'localId');
    return `transcript:${sessionId}:${localId}`;
}

export function createSessionEndMutation(params: Readonly<{
    sessionId: string;
    observedAt?: number;
    exit?: unknown;
}>): SessionEndMutationV1 {
    return {
        v: 1,
        sessionId: params.sessionId,
        mutationId: randomUUID(),
        source: 'session_end',
        observedAt: normalizeObservedAt(params.observedAt ?? Date.now()),
        ...(params.exit !== undefined ? { exit: params.exit } : {}),
    };
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
}>): TranscriptMessageAppendMutationV1 {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const localId = normalizeRequiredString(params.localId, 'localId');
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
        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
    };
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
        mutationId: randomUUID(),
        fieldId: params.fieldId,
        deliveryClass: params.deliveryClass ?? 'durable_required',
        op: params.op,
        source: params.source,
        observedAt: normalizeObservedAt(params.observedAt ?? Date.now()),
        ...(params.dependsOn && params.dependsOn.length > 0 ? { dependsOn: normalizeDependencies(params.dependsOn) } : {}),
    };
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
