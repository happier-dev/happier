import { createHash, randomUUID } from 'node:crypto';

import {
    SessionRuntimeActivitySnapshotSchema,
    SessionTranscriptObservationProvenanceV1Schema,
} from '@happier-dev/protocol';
import type {
    SessionRuntimeActivitySnapshot,
    SessionRuntimeIssueV1,
    SessionMessageRole,
    SessionStoredMessageContent,
    SessionTurnMutationActionV1,
    SessionTurnTranscriptAnchorsV1,
    SessionTurnMutationV1,
    SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';

export type {
    SessionTurnMutationActionV1,
    SessionTurnMutationV1,
} from '@happier-dev/protocol';

export function resolveLegacyDaemonObservedExitMutationId(params: Readonly<{
    sessionId: string;
    turnId: string;
}>): string {
    const digest = createHash('sha256')
        .update(JSON.stringify({ sessionId: params.sessionId, turnId: params.turnId }))
        .digest('hex');
    return `daemon-observed-exit:${digest}`;
}

export function resolveDaemonObservedExitMutationId(params: Readonly<{
    sessionId: string;
    turnId: string;
    observedAt: number;
}>): string {
    const digest = createHash('sha256')
        .update(JSON.stringify({
            sessionId: params.sessionId,
            turnId: params.turnId,
            observedAt: params.observedAt,
        }))
        .digest('hex');
    return `daemon-observed-exit:${digest}`;
}

export type TranscriptMessageAppendMutationContentV1 =
    | string
    | SessionStoredMessageContent;

type TranscriptMessageAppendMutationBaseV1 = Readonly<{
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

/** Canonical V1 writer shape. Every deliverable observation has explicit causal provenance. */
export type TranscriptMessageAppendMutationV1 = TranscriptMessageAppendMutationBaseV1 & Readonly<{
    provenance: SessionTranscriptObservationProvenanceV1;
}>;

/**
 * Recovery-only reader shape for public-dev V1 journals written before causal provenance existed.
 * It remains in the same journal and is never delivered or silently reclassified.
 */
export type BlockedLegacyTranscriptMessageAppendMutationV1 = TranscriptMessageAppendMutationBaseV1 & Readonly<{
    provenance?: unknown;
}>;

export type PersistedTranscriptMessageAppendMutationV1 =
    | TranscriptMessageAppendMutationV1
    | BlockedLegacyTranscriptMessageAppendMutationV1;

export function validateTranscriptMessageAppendMutationProvenance(params: Readonly<{
    sessionId: string;
    provenance?: unknown;
}>): SessionTranscriptObservationProvenanceV1 {
    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(params.provenance);
    if (!provenance.success) {
        throw new Error('Transcript append mutation provenance is required');
    }
    return provenance.data;
}

export function hasSameTranscriptMessageAppendMutationProvenance(
    left: Pick<PersistedTranscriptMessageAppendMutationV1, 'sessionId' | 'provenance'>,
    right: Pick<PersistedTranscriptMessageAppendMutationV1, 'sessionId' | 'provenance'>,
): boolean {
    let leftProvenance: SessionTranscriptObservationProvenanceV1;
    let rightProvenance: SessionTranscriptObservationProvenanceV1;
    try {
        leftProvenance = validateTranscriptMessageAppendMutationProvenance(left);
        rightProvenance = validateTranscriptMessageAppendMutationProvenance(right);
    } catch {
        return false;
    }
    return leftProvenance.source === rightProvenance.source;
}

export type RuntimeActivitySnapshotMutationV1 = Readonly<{
    v: 1;
    source: 'runtime_activity_snapshot';
    sessionId: string;
    mutationId: string;
    snapshot: SessionRuntimeActivitySnapshot;
}>;

export function resolveRuntimeActivitySnapshotMutationId(sessionId: string): string {
    return `runtime-activity-snapshot:${normalizeRequiredString(sessionId, 'sessionId')}`;
}

export function createRuntimeActivitySnapshotMutation(params: Readonly<{
    sessionId: string;
    snapshot: SessionRuntimeActivitySnapshot;
}>): RuntimeActivitySnapshotMutationV1 {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    return {
        v: 1,
        source: 'runtime_activity_snapshot',
        sessionId,
        mutationId: resolveRuntimeActivitySnapshotMutationId(sessionId),
        snapshot: SessionRuntimeActivitySnapshotSchema.parse(params.snapshot),
    };
}

export function resolveTranscriptMessageAppendMutationId(params: Readonly<{
    sessionId: string;
    localId: string;
}>): string {
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const localId = normalizeRequiredString(params.localId, 'localId');
    return `transcript:${sessionId}:${localId}`;
}

export type QueuedSessionMutation =
    | Readonly<{
        kind: 'session_turn';
        mutationId: string;
        payload: SessionTurnMutationV1;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
    }>
    | Readonly<{
        kind: 'transcript_message_append';
        mutationId: string;
        payload: PersistedTranscriptMessageAppendMutationV1;
        /** Client-local monotonic enqueue order; never sent in the server payload. */
        intentOrder?: number;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
    }>
    | Readonly<{
        kind: 'runtime_activity_snapshot';
        mutationId: string;
        payload: RuntimeActivitySnapshotMutationV1;
        /** Durable monotonic identity for the current coalesced runtime snapshot. */
        admissionOrder: number;
        createdAt: number;
        attempts: number;
        nextAttemptAt: number;
    }>;

export function createSessionTurnMutation(params: Readonly<{
    sessionId: string;
    action: SessionTurnMutationActionV1;
    turnId?: string;
    provider?: string | null;
    providerTurnId?: string | null;
    issue?: SessionRuntimeIssueV1 | null;
    transcriptAnchors?: SessionTurnTranscriptAnchorsV1;
    providerRollbackOrdinal?: number;
    restoredToTurnId?: string;
    reason?: string;
    mutationId?: string;
    observedAt?: number;
    now?: number;
}>): SessionTurnMutationV1 {
    const observedAt = normalizeObservedAt(params.observedAt ?? params.now ?? Date.now());
    const mutationId = params.mutationId ?? randomUUID();
    const provider = normalizeOptionalString(params.provider);
    const providerTurnId = normalizeOptionalString(params.providerTurnId);
    const turnId = normalizeOptionalString(params.turnId);
    return {
        v: 1,
        sessionId: params.sessionId,
        mutationId,
        action: params.action,
        ...(turnId ? { turnId } : {}),
        ...('issue' in params && params.issue ? { issue: params.issue } : {}),
        ...(params.transcriptAnchors !== undefined ? { transcriptAnchors: params.transcriptAnchors } : {}),
        ...(typeof params.providerRollbackOrdinal === 'number' ? { providerRollbackOrdinal: params.providerRollbackOrdinal } : {}),
        ...(params.restoredToTurnId ? { restoredToTurnId: params.restoredToTurnId } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
        ...(provider ? { provider } : {}),
        ...(providerTurnId !== undefined ? { providerTurnId } : {}),
        observedAt,
    } as SessionTurnMutationV1;
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
    const localId = normalizeRequiredString(params.localId, 'localId');
    const sessionId = normalizeRequiredString(params.sessionId, 'sessionId');
    const createdAt = normalizeObservedAt(params.createdAt ?? Date.now());
    const updatedAt = normalizeObservedAt(params.updatedAt ?? createdAt);
    const sidechainId = normalizeOptionalString(params.sidechainId);
    const provenance = validateTranscriptMessageAppendMutationProvenance({
        sessionId,
        provenance: params.provenance,
    });
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
        provenance,
        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
    };
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
