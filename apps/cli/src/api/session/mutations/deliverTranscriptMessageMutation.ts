import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    SessionTranscriptObservationAckV1Schema,
    SessionTranscriptObservationCapabilityAckV1Schema,
    SessionTranscriptObservationProvenanceV1Schema,
    SessionTranscriptObservationV1Schema,
    MessageAckResponseSchema,
} from '@happier-dev/protocol';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

import type { PersistedTranscriptMessageAppendMutationV1 } from './sessionMutationTypes';

type TranscriptMessageMutationSocket = {
    connected?: boolean;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => TranscriptMessageMutationSocket;
};

export type TranscriptMessageMutationDeliveryResult =
    | Readonly<{ status: 'delivered'; path: 'socket' }>
    | Readonly<{
        status: 'permanent_invalid_payload';
        reason: 'transcript_observation_invalid';
    }>
    | Readonly<{
        status: 'retryable';
        reason: 'transcript_observation_transport_unavailable';
    }>
    | Readonly<{
        status: 'unsupported_capability';
        reason:
            | 'transcript_observation_provenance_missing_or_invalid'
            | 'transcript_observation_provenance_conflict'
            | 'transcript_observation_transport_unsupported';
    }>;

const positivelyNegotiatedSockets = new WeakSet<object>();

function resolveObservation(
    mutation: PersistedTranscriptMessageAppendMutationV1,
) {
    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(mutation.provenance);
    if (!provenance.success) {
        return { ok: false, reason: 'transcript_observation_provenance_missing_or_invalid' as const };
    }
    const observation = SessionTranscriptObservationV1Schema.safeParse({
        v: 1,
        sessionId: mutation.sessionId,
        localId: mutation.localId,
        ...(mutation.sidechainId !== undefined ? { sidechainId: mutation.sidechainId } : {}),
        ...(mutation.messageRole ? { messageRole: mutation.messageRole } : {}),
        content: mutation.content,
        createdAt: mutation.createdAt,
        updatedAt: mutation.updatedAt,
        provenance: provenance.data,
        ...(mutation.sessionEventType ? { sessionEventType: mutation.sessionEventType } : {}),
    });
    if (!observation.success) {
        return { ok: false, reason: 'transcript_observation_provenance_conflict' as const };
    }
    return { ok: true, observation: observation.data } as const;
}

async function negotiateObservationCapability(params: Readonly<{
    socket: TranscriptMessageMutationSocket;
    sessionId: string;
}>): Promise<boolean> {
    if (params.socket.connected !== true) return false;
    if (positivelyNegotiatedSockets.has(params.socket as object)) return true;
    const raw = await emitSocketWithAck({
        socket: params.socket,
        event: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
        payload: { v: 1, sessionId: params.sessionId },
    });
    const parsed = SessionTranscriptObservationCapabilityAckV1Schema.safeParse(raw);
    if (!parsed.success || !parsed.data.ok || parsed.data.capability !== SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1) {
        return false;
    }
    positivelyNegotiatedSockets.add(params.socket as object);
    return true;
}

export async function deliverTranscriptMessageMutation(params: Readonly<{
    token: string;
    socket: TranscriptMessageMutationSocket;
    mutation: PersistedTranscriptMessageAppendMutationV1;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    const resolved = resolveObservation(params.mutation);
    if (!resolved.ok) {
        return { status: 'unsupported_capability', reason: resolved.reason };
    }

    try {
        const supported = await negotiateObservationCapability({
            socket: params.socket,
            sessionId: params.mutation.sessionId,
        });
        if (!supported) {
            return { status: 'unsupported_capability', reason: 'transcript_observation_transport_unsupported' };
        }
        const raw = await emitSocketWithAck({
            socket: params.socket,
            event: SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
            payload: resolved.observation,
        });
        const parsed = SessionTranscriptObservationAckV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { status: 'retryable', reason: 'transcript_observation_transport_unavailable' };
        }
        if (!parsed.data.ok) {
            if (parsed.data.error === 'forbidden') {
                return { status: 'unsupported_capability', reason: 'transcript_observation_transport_unsupported' };
            }
            if (parsed.data.error === 'invalid_observation') {
                return { status: 'permanent_invalid_payload', reason: 'transcript_observation_invalid' };
            }
            return { status: 'retryable', reason: 'transcript_observation_transport_unavailable' };
        }
        return { status: 'delivered', path: 'socket' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return { status: 'retryable', reason: 'transcript_observation_transport_unavailable' };
    }
}

/**
 * Exact cli-v0.2.1/server-v0.2.1 transcript transport. The adapter only translates
 * the durable mutation to the released `message` event; persistence and idempotency
 * remain owned by the server's canonical session-message writer.
 */
export async function deliverTranscriptMessageMutationToReleasedServerV021(params: Readonly<{
    socket: TranscriptMessageMutationSocket;
    mutation: PersistedTranscriptMessageAppendMutationV1;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    if (params.socket.connected !== true) {
        return { status: 'retryable', reason: 'transcript_observation_transport_unavailable' };
    }
    try {
        const raw = await emitSocketWithAck({
            socket: params.socket,
            event: 'message',
            payload: {
                sid: params.mutation.sessionId,
                message: params.mutation.content,
                localId: params.mutation.localId,
                echoToSender: true,
                ...(params.mutation.sidechainId !== undefined
                    ? { sidechainId: params.mutation.sidechainId }
                    : {}),
                ...(params.mutation.messageRole
                    ? { messageRole: params.mutation.messageRole }
                    : {}),
            },
        });
        const parsed = MessageAckResponseSchema.safeParse(raw);
        return parsed.success && parsed.data.ok
            ? { status: 'delivered', path: 'socket' }
            : { status: 'retryable', reason: 'transcript_observation_transport_unavailable' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return { status: 'retryable', reason: 'transcript_observation_transport_unavailable' };
    }
}
