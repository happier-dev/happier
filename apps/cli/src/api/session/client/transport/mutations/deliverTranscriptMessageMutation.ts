import { isAuthenticationError } from '@/api/client/httpStatusError';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    SessionTranscriptObservationAckV1Schema,
    SessionTranscriptObservationProvenanceV1Schema,
    MessageAckResponseSchema,
} from '@happier-dev/protocol';
import type { SessionClientConnectionContractResult } from '../sessionClientConnectionContract';

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

async function trySocketTranscriptMutation(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    mutation: TranscriptMessageAppendMutationV1;
}>): Promise<TranscriptSocketDeliveryResult> {
    if (params.socket.connected !== true) return { status: 'unavailable' };
    try {
        const socket = params.socket.timeout?.(10_000) ?? params.socket;
        if (typeof socket.emitWithAck !== 'function') return { status: 'unavailable' };
        const raw = await emitSocketWithAck({
            socket,
            event: SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            payload: {
                v: 1,
                sessionId: params.mutation.sessionId,
                localId: params.mutation.localId,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
                content: params.mutation.content,
                createdAt: params.mutation.createdAt,
                updatedAt: params.mutation.updatedAt,
                provenance: params.mutation.provenance,
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            },
        });
        const parsed = SessionTranscriptObservationAckV1Schema.safeParse(raw);
        if (!parsed.success) return { status: 'failed' };
        if (parsed.data.ok !== true) {
            return parsed.data.error === 'invalid_observation'
                ? { status: 'invalid' }
                : { status: 'failed' };
        }
        if (parsed.data.localId !== params.mutation.localId) return { status: 'failed' };
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
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
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
}>): Promise<TranscriptSocketDeliveryResult> {
    if (params.socket.connected !== true) return { status: 'unavailable' };
    try {
        const socket = params.socket.timeout?.(10_000) ?? params.socket;
        if (typeof socket.emitWithAck !== 'function') return { status: 'unavailable' };
        const raw = await emitSocketWithAck({
            socket,
            event: 'message',
            payload: {
                sid: params.mutation.sessionId,
                message: params.mutation.content,
                localId: params.mutation.localId,
                echoToSender: true,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
            },
        });
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
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    const parsedProvenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(params.mutation.provenance);
    if (!parsedProvenance.success) {
        return { delivered: false, reason: 'transcript_message_provenance_missing_or_invalid' };
    }
    const mutation: TranscriptMessageAppendMutationV1 = {
        ...params.mutation,
        provenance: parsedProvenance.data,
    };
    if (params.connectionContract?.transcriptTransport.mode === 'released_server_v0_2_1') {
        const releasedResult = params.socket
            ? await tryReleasedServerV021TranscriptMutation({ socket: params.socket, mutation })
            : { status: 'unavailable' as const };
        return toTranscriptMessageMutationDeliveryResult(releasedResult);
    }
    if (params.connectionContract?.transcriptTransport.mode !== 'session_transcript_observation_v1') {
        return { delivered: false, reason: 'transcript_message_transport_unavailable' };
    }
    const socketResult = params.socket
        ? await trySocketTranscriptMutation({ socket: params.socket, mutation })
        : { status: 'unavailable' as const };
    return toTranscriptMessageMutationDeliveryResult(socketResult);
}
