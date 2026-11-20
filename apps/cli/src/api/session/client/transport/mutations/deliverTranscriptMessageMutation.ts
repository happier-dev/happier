import { isAuthenticationError } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_BATCH_MAX_ENCODED_BYTES_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    SessionTranscriptObservationAckV1Schema,
    SessionTranscriptObservationBatchAckV1Schema,
    SessionTranscriptObservationProvenanceV1Schema,
} from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';
import type { SessionClientConnectionContractResult } from '../sessionClientConnectionContract';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

import type {
    PersistedTranscriptMessageAppendMutationV1,
    SessionClientDurableMutationSocket,
    TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';

export type TranscriptMessageMutationDeliveryResult =
    | Readonly<{ delivered: true; path: 'socket'; ack?: TranscriptMessageMutationDeliveryAck }>
    | Readonly<{
        delivered: false;
        reason:
            | 'transcript_message_provenance_missing_or_invalid'
            | 'transcript_message_transport_unavailable'
            | 'transcript_message_invalid_observation'
            | 'transcript_message_delivery_failed';
    }>;

export type TranscriptMessageMutationDeliveryAck = Readonly<{
    id: string;
    seq: number;
    localId: string | null;
    didWrite?: boolean;
    didUpdate?: boolean;
}>;

type TranscriptSocketDeliveryResult =
    | Readonly<{ status: 'delivered'; ack: TranscriptMessageMutationDeliveryAck }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'invalid' }>
    | Readonly<{ status: 'failed' }>;

function buildTranscriptObservationPayload(mutation: TranscriptMessageAppendMutationV1, version: 1 | 2) {
    return {
        v: version,
        sessionId: mutation.sessionId,
        localId: mutation.localId,
        sidechainId: mutation.sidechainId ?? null,
        ...(mutation.messageRole ? { messageRole: mutation.messageRole } : {}),
        content: mutation.content,
        ...(mutation.usageTimingV1 === undefined ? {} : { usageTimingV1: mutation.usageTimingV1 }),
        createdAt: mutation.createdAt,
        updatedAt: mutation.updatedAt,
        provenance: mutation.provenance,
        ...(version === 2 && mutation.surfaceItemReference !== undefined
            ? { surfaceItemReference: mutation.surfaceItemReference } : {}),
        ...(version === 2 && mutation.toolOutputPart !== undefined
            ? { toolOutputPart: mutation.toolOutputPart } : {}),
        ...(version === 2 && mutation.approvalRequestArtifactId !== undefined
            ? { approvalRequestArtifactId: mutation.approvalRequestArtifactId } : {}),
        ...(mutation.sessionEventType ? { sessionEventType: mutation.sessionEventType } : {}),
        ...(mutation.append ? { append: mutation.append } : {}),
    };
}

function readTranscriptObservationAck(raw: unknown, localId: string): TranscriptSocketDeliveryResult {
    const parsed = SessionTranscriptObservationAckV1Schema.safeParse(raw);
    if (!parsed.success) return { status: 'failed' };
    if (parsed.data.ok !== true) {
        return parsed.data.error === 'invalid_observation'
            ? { status: 'invalid' }
            : { status: 'failed' };
    }
    if (parsed.data.localId !== localId) return { status: 'failed' };
    return {
        status: 'delivered',
        ack: {
            id: parsed.data.id,
            seq: parsed.data.seq,
            localId: parsed.data.localId,
            didWrite: parsed.data.didWrite,
            ...(typeof parsed.data.didUpdate === 'boolean' ? { didUpdate: parsed.data.didUpdate } : {}),
        },
    };
}

/**
 * A failed socket attempt stays retained and retried by the outbox. Session runners log at
 * info, so the attempt is recorded there (the same line the outbox writes for thrown failures).
 */
function logTranscriptDeliveryFailure(sessionId: string, rows: number, error: unknown): void {
    logger.infoFile('[API] Durable session mutation delivery failed', {
        sessionId, mutationKind: 'transcript_message_append', rows, error: serializeAxiosErrorForLog(error),
    });
}

async function trySocketTranscriptMutation(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    mutation: TranscriptMessageAppendMutationV1;
    version: 1 | 2;
    signal?: AbortSignal;
}>): Promise<TranscriptSocketDeliveryResult> {
    if (params.socket.connected !== true) return { status: 'unavailable' };
    try {
        const socket = params.socket;
        if (typeof socket.emitWithAck !== 'function') return { status: 'unavailable' };
        const raw = await timeWebLatencyPhase('session.transcript.socket_ack', () => emitSocketWithAck({
            socket,
            event: SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            timeoutMs: null,
            signal: params.signal,
            payload: buildTranscriptObservationPayload(params.mutation, params.version),
        }));
        return readTranscriptObservationAck(raw, params.mutation.localId);
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        logTranscriptDeliveryFailure(params.mutation.sessionId, 1, error);
        return { status: 'failed' };
    }
}

/**
 * Exact CLI/server-v0.2.1 transcript transport from
 * b1d15a8a9c241737d1ca9b167459901e6259173a and
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2. Remove it when 0.2.1 leaves the
 * supported predecessor window.
 */
async function tryReleasedServerV021TranscriptMutation(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    mutation: TranscriptMessageAppendMutationV1;
    signal?: AbortSignal;
}>): Promise<TranscriptSocketDeliveryResult> {
    if (params.socket.connected !== true) return { status: 'unavailable' };
    try {
        const socket = params.socket;
        if (typeof socket.emitWithAck !== 'function') return { status: 'unavailable' };
        const raw = await timeWebLatencyPhase('session.transcript.socket_ack', () => emitSocketWithAck({
            socket,
            event: 'message',
            timeoutMs: null,
            signal: params.signal,
            payload: {
                sid: params.mutation.sessionId,
                message: params.mutation.content,
                ...(params.mutation.usageTimingV1 === undefined ? {} : { usageTimingV1: params.mutation.usageTimingV1 }),
                localId: params.mutation.localId,
                echoToSender: true,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
            },
        }));
        const parsed = MessageAckResponseSchema.safeParse(raw);
        if (!parsed.success || parsed.data.ok !== true) return { status: 'failed' };
        if (parsed.data.localId !== params.mutation.localId) return { status: 'failed' };
        return {
            status: 'delivered',
            ack: {
                id: parsed.data.id,
                seq: parsed.data.seq,
                localId: parsed.data.localId,
                didWrite: parsed.data.didWrite,
            },
        };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        logTranscriptDeliveryFailure(params.mutation.sessionId, 1, error);
        return { status: 'failed' };
    }
}

function toTranscriptMessageMutationDeliveryResult(
    result: TranscriptSocketDeliveryResult,
): TranscriptMessageMutationDeliveryResult {
    if (result.status === 'delivered') {
        return { delivered: true, path: 'socket', ack: result.ack };
    }
    if (result.status === 'invalid') {
        return { delivered: false, reason: 'transcript_message_invalid_observation' };
    }
    return result.status === 'unavailable'
        ? { delivered: false, reason: 'transcript_message_transport_unavailable' }
        : { delivered: false, reason: 'transcript_message_delivery_failed' };
}

export async function deliverTranscriptMessageMutation(params: Readonly<{
    token: string;
    socket: SessionClientDurableMutationSocket | null;
    connectionContract?: SessionClientConnectionContractResult | null;
    mutation: PersistedTranscriptMessageAppendMutationV1;
    signal?: AbortSignal;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    const parsedProvenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(params.mutation.provenance);
    if (!parsedProvenance.success) {
        return { delivered: false, reason: 'transcript_message_provenance_missing_or_invalid' };
    }
    const mutation: TranscriptMessageAppendMutationV1 = {
        ...params.mutation,
        provenance: parsedProvenance.data,
    };
    const mode = params.connectionContract?.transcriptTransport.mode;
    if (mutation.toolOutputPart !== undefined && mode !== 'session_transcript_observation_v2') {
        return { delivered: false, reason: 'transcript_message_transport_unavailable' };
    }
    if (mode === 'released_server_v0_2_1') {
        const releasedResult = params.socket
            ? await tryReleasedServerV021TranscriptMutation({ socket: params.socket, mutation, signal: params.signal })
            : { status: 'unavailable' as const };
        return toTranscriptMessageMutationDeliveryResult(releasedResult);
    }
    if (mode !== 'session_transcript_observation_v1' && mode !== 'session_transcript_observation_v2') {
        return { delivered: false, reason: 'transcript_message_transport_unavailable' };
    }
    const socketResult = params.socket
        ? await trySocketTranscriptMutation({ socket: params.socket, mutation,
            signal: params.signal,
            version: mode === 'session_transcript_observation_v2' ? 2 : 1 })
        : { status: 'unavailable' as const };
    return toTranscriptMessageMutationDeliveryResult(socketResult);
}

/**
 * Delivers consecutive observations in one ordered frame. Home observes them in order and stops at
 * its first refusal, so the results cover exactly the observed prefix (the last one may be the
 * refusal); members after it were not observed and stay queued. Returns null when this connection
 * has no batch transport or the first member alone does not fit one frame, so the caller sends it
 * through the single observation path.
 */
export async function deliverTranscriptMessageMutationBatch(params: Readonly<{
    socket: SessionClientDurableMutationSocket | null;
    connectionContract?: SessionClientConnectionContractResult | null;
    mutations: readonly PersistedTranscriptMessageAppendMutationV1[];
    signal?: AbortSignal;
    /** Called once with the number of leading members about to be sent. */
    onSend?: (count: number) => void;
}>): Promise<Readonly<{ sent: number; results: readonly TranscriptMessageMutationDeliveryResult[] }> | null> {
    const mode = params.connectionContract?.transcriptTransport.mode;
    if (mode !== 'session_transcript_observation_v1' && mode !== 'session_transcript_observation_v2') return null;
    const socket = params.socket;
    if (!socket || socket.connected !== true || typeof socket.emitWithAck !== 'function') return null;
    const version = mode === 'session_transcript_observation_v2' ? 2 : 1;
    const sessionId = params.mutations[0]?.sessionId;
    const members: TranscriptMessageAppendMutationV1[] = [];
    const observations: unknown[] = [];
    let encodedBytes = Buffer.byteLength(JSON.stringify([SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1,
        { v: 1, sessionId, observations: [] }]));
    for (const persisted of params.mutations) {
        if (persisted.sessionId !== sessionId || (version !== 2 && persisted.toolOutputPart !== undefined)) break;
        const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(persisted.provenance);
        if (!provenance.success) break;
        const mutation: TranscriptMessageAppendMutationV1 = { ...persisted, provenance: provenance.data };
        const observation = buildTranscriptObservationPayload(mutation, version);
        const bytes = Buffer.byteLength(JSON.stringify(observation)) + (observations.length > 0 ? 1 : 0);
        if (encodedBytes + bytes > SESSION_TRANSCRIPT_OBSERVATION_BATCH_MAX_ENCODED_BYTES_V1) break;
        encodedBytes += bytes;
        members.push(mutation);
        observations.push(observation);
    }
    if (members.length < 2) return null;
    params.onSend?.(members.length);
    let raw: unknown;
    try {
        raw = await timeWebLatencyPhase('session.transcript.socket_ack', () => emitSocketWithAck({
            socket,
            event: SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1,
            timeoutMs: null,
            signal: params.signal,
            payload: { v: 1, sessionId, observations },
        }));
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        logTranscriptDeliveryFailure(sessionId, members.length, error);
        return { sent: members.length, results: [{ delivered: false, reason: 'transcript_message_delivery_failed' }] };
    }
    const parsed = SessionTranscriptObservationBatchAckV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.ok !== true || parsed.data.acks.length === 0
        || parsed.data.acks.length > members.length) {
        const invalid = parsed.success && parsed.data.ok === false && parsed.data.error === 'invalid_observation';
        return { sent: members.length, results: [toTranscriptMessageMutationDeliveryResult(
            invalid ? { status: 'invalid' } : { status: 'failed' })] };
    }
    const results = parsed.data.acks.map((ack, index) =>
        toTranscriptMessageMutationDeliveryResult(readTranscriptObservationAck(ack, members[index]!.localId)));
    return { sent: members.length, results };
}
