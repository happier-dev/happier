import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
};

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean }
    | { ok: true; didMaterialize: false }
    | { ok: false };

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
        const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as any;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        return pending
            .map((row: any) => (typeof row?.localId === 'string' ? row.localId : null))
            .filter((value: string | null): value is string => typeof value === 'string' && value.length > 0);
    } catch {
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
    const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
    for (const localId of params.localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: { Authorization: `Bearer ${params.token}` }, timeout: 10_000 },
            );
            discarded += 1;
        } catch {
            // Best-effort discard; continue.
        }
    }
    return discarded;
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await (params.socket as any).timeout(7_500).emitWithAck('pending-materialize-next', { sid: params.sessionId });
        if (!rawAck || typeof rawAck !== 'object') return { ok: false };
        if (rawAck.ok !== true) return { ok: false };
        if (rawAck.didMaterialize !== true) return { ok: true, didMaterialize: false };
        const localId = typeof rawAck?.message?.localId === 'string' ? String(rawAck.message.localId) : null;
        const didWrite = rawAck.didWrite === true;
        return { ok: true, didMaterialize: true, localId, didWrite };
    } catch {
        return { ok: false };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
        const response = await axios.post(
            `${serverUrl}/v2/sessions/${params.sessionId}/pending/materialize-next`,
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
        if (!data || typeof data !== 'object') return { ok: false };
        if (data.ok !== true) return { ok: false };
        if (data.didMaterialize !== true) return { ok: true, didMaterialize: false };
        const localId = typeof data?.message?.localId === 'string' ? String(data.message.localId) : null;
        const didWrite = data.didWrite === true || data.didWriteMessage === true;
        return { ok: true, didMaterialize: true, localId, didWrite };
    } catch {
        return { ok: false };
    }
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
}): Promise<PendingQueueMaterializeNextResult | null> {
    const socketRes = params.socket.connected
        ? await tryMaterializeNextViaSocket({ socket: params.socket, sessionId: params.sessionId })
        : ({ ok: false } as const);
    const res = socketRes.ok ? socketRes : await tryMaterializeNextViaHttp({ token: params.token, sessionId: params.sessionId });
    if (!res.ok) return null;
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
