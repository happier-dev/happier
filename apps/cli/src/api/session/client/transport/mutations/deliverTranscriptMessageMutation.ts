import axios from 'axios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { configuration } from '@/configuration';
import { MessageAckResponseSchema } from '@/api/types';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

import type {
    SessionClientDurableMutationSocket,
    TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';

export type TranscriptMessageMutationDeliveryResult =
    | Readonly<{ delivered: true; path: 'socket' | 'http' }>
    | Readonly<{ delivered: false; reason: 'transcript_message_transport_unavailable'; httpStatus?: number }>;

function readHttpErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const directStatus = (error as { status?: unknown }).status;
    if (typeof directStatus === 'number') return directStatus;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return undefined;
    const status = (response as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
}

async function trySocketTranscriptMutation(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    mutation: TranscriptMessageAppendMutationV1;
}>): Promise<boolean> {
    if (params.socket.connected !== true) return false;
    try {
        const socket = params.socket.timeout?.(10_000) ?? params.socket;
        if (typeof socket.emitWithAck !== 'function') return false;
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
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            },
        });
        const parsed = MessageAckResponseSchema.safeParse(raw);
        return parsed.success && parsed.data.ok === true;
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return false;
    }
}

async function tryHttpTranscriptMutation(params: Readonly<{
    token: string;
    mutation: TranscriptMessageAppendMutationV1;
    serverUrl: string;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    try {
        const body = typeof params.mutation.content === 'string'
            ? {
                ciphertext: params.mutation.content,
                localId: params.mutation.localId,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            }
            : {
                content: params.mutation.content,
                localId: params.mutation.localId,
                sidechainId: params.mutation.sidechainId ?? null,
                ...(params.mutation.messageRole ? { messageRole: params.mutation.messageRole } : {}),
                ...(params.mutation.sessionEventType ? { sessionEventType: params.mutation.sessionEventType } : {}),
            };
        const response = await axios.post(
            `${params.serverUrl}/v2/sessions/${encodeURIComponent(params.mutation.sessionId)}/messages`,
            body,
            {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': params.mutation.localId,
                },
                timeout: 10_000,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (data && (data.ok === false || data.result === 'error')) {
            return { delivered: false, reason: 'transcript_message_transport_unavailable' };
        }
        return { delivered: true, path: 'http' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return {
            delivered: false,
            reason: 'transcript_message_transport_unavailable',
            httpStatus: readHttpErrorStatus(error),
        };
    }
}

export async function deliverTranscriptMessageMutation(params: Readonly<{
    token: string;
    socket: SessionClientDurableMutationSocket | null;
    mutation: TranscriptMessageAppendMutationV1;
}>): Promise<TranscriptMessageMutationDeliveryResult> {
    const socketDelivered = params.socket
        ? await trySocketTranscriptMutation({
            socket: params.socket,
            mutation: params.mutation,
        })
        : false;
    if (socketDelivered) return { delivered: true, path: 'socket' };

    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    return await tryHttpTranscriptMutation({
        token: params.token,
        mutation: params.mutation,
        serverUrl,
    });
}
