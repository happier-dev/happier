import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
};

type PendingQueueWriteBody = Readonly<
    | { localId: string; ciphertext: string; messageRole?: 'user' | 'agent' | 'event' | 'unknown' }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: 'user' | 'agent' | 'event' | 'unknown' }
>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean }
    | { ok: true; didMaterialize: false }
    | { ok: false };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean }
    | { ok: true; didMaterialize: false };

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
        const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as any;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        return pending
            .map((row: any) => (typeof row?.localId === 'string' ? row.localId : null))
            .filter((value: string | null): value is string => typeof value === 'string' && value.length > 0);
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        return [];
    }
}

export async function discardPendingQueueV2Messages(params: {
    token: string;
    sessionId: string;
    localIds: string[];
    reason: 'switch_to_local' | 'manual';
}): Promise<number> {
    let discarded = 0;
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    for (const localId of params.localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: { Authorization: `Bearer ${params.token}` }, timeout: 10_000 },
            );
            discarded += 1;
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            // Best-effort discard; continue.
        }
    }
    return discarded;
}

export async function enqueuePendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    body: PendingQueueWriteBody;
}): Promise<void> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        params.body,
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: params.socket as any,
            event: 'pending-materialize-next',
            payload: { sid: params.sessionId },
        });
        if (!rawAck || typeof rawAck !== 'object') return { ok: false };
        if (rawAck.ok !== true) return { ok: false };
        if (rawAck.didMaterialize !== true) return { ok: true, didMaterialize: false };
        const message = rawAck.message;
        const localId = message && typeof message === 'object' && 'localId' in message && typeof message.localId === 'string'
            ? String(message.localId)
            : null;
        const didWrite = rawAck.didWrite === true;
        return { ok: true, didMaterialize: true, localId, didWrite };
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        return { ok: false };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        {},
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                "Content-Type": "application/json",
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending queue materialize response');
    }
    if (data.ok !== true) {
        throw new Error(`Pending queue materialize failed: ${typeof data.error === 'string' ? data.error : 'unknown'}`);
    }
    if (data.didMaterialize !== true) return { ok: true, didMaterialize: false };
    const localId = typeof data?.message?.localId === 'string' ? String(data.message.localId) : null;
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    return { ok: true, didMaterialize: true, localId, didWrite };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueMaterializeNextResult> {
    const res = await tryMaterializeNextViaHttp(params);
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
    };
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
}): Promise<PendingQueueMaterializeNextResult> {
    const socketRes = params.socket.connected
        ? await tryMaterializeNextViaSocket({ socket: params.socket, sessionId: params.sessionId })
        : ({ ok: false } as const);
    const res = socketRes.ok ? socketRes : await tryMaterializeNextViaHttp({ token: params.token, sessionId: params.sessionId });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
    };
}
