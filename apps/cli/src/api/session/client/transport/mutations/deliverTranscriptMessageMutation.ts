import axios from 'axios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { MessageAckResponseSchema } from '@/api/types';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

import type {
    SessionClientDurableMutationSocket,
    TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';

export type TranscriptMessageMutationDeliveryResult =
    | Readonly<{ delivered: true; path: 'socket' | 'http'; ack?: TranscriptMessageMutationDeliveryAck }>
    | Readonly<{ delivered: false; reason: 'transcript_message_transport_unavailable'; httpStatus?: number }>;

export type TranscriptMessageMutationDeliveryAck = Readonly<{
    id: string;
    seq: number;
    localId: string | null;
    didWrite?: boolean;
    didUpdate?: boolean;
}>;

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
}>): Promise<TranscriptMessageMutationDeliveryAck | null> {
    if (params.socket.connected !== true) return null;
    try {
        const socket = params.socket.timeout?.(10_000) ?? params.socket;
        if (typeof socket.emitWithAck !== 'function') return null;
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
        if (!parsed.success || parsed.data.ok !== true) return null;
        return {
            id: parsed.data.id,
            seq: parsed.data.seq,
            localId: parsed.data.localId,
            ...(typeof parsed.data.didWrite === 'boolean' ? { didWrite: parsed.data.didWrite } : {}),
            ...(typeof parsed.data.didUpdate === 'boolean' ? { didUpdate: parsed.data.didUpdate } : {}),
        };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return null;
    }
}

function readHttpTranscriptMutationAck(data: unknown): TranscriptMessageMutationDeliveryAck | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const message = (data as { message?: unknown }).message;
    if (!message || typeof message !== 'object') return undefined;
    const record = message as Record<string, unknown>;
    if (typeof record.id !== 'string') return undefined;
    if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 0) return undefined;
    const localId = typeof record.localId === 'string' ? record.localId : null;
    return {
        id: record.id,
        seq: record.seq,
        localId,
        ...('didWrite' in data && typeof (data as { didWrite?: unknown }).didWrite === 'boolean'
            ? { didWrite: (data as { didWrite: boolean }).didWrite }
            : {}),
        ...('didUpdate' in data && typeof (data as { didUpdate?: unknown }).didUpdate === 'boolean'
            ? { didUpdate: (data as { didUpdate: boolean }).didUpdate }
            : {}),
    };
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
        return {
            delivered: true,
            path: 'http',
            ack: readHttpTranscriptMutationAck(data),
        };
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
    const socketAck = params.socket
        ? await trySocketTranscriptMutation({
            socket: params.socket,
            mutation: params.mutation,
        })
        : null;
    if (socketAck) return { delivered: true, path: 'socket', ack: socketAck };

    const serverUrl = resolveServerHttpBaseUrl();
    return await tryHttpTranscriptMutation({
        token: params.token,
        mutation: params.mutation,
        serverUrl,
    });
}
