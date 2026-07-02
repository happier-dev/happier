import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    pendingQueueState: KnownPendingQueueState | null;
    message: PendingQueueMaterializedMessage | null;
};

type PendingQueueWriteBody = Readonly<
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole }
>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; pendingQueueState: KnownPendingQueueState | null; message: PendingQueueMaterializedMessage | null }
    | { ok: true; didMaterialize: false; pendingQueueState: KnownPendingQueueState | null }
    | { ok: false };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; pendingQueueState: KnownPendingQueueState | null; message: PendingQueueMaterializedMessage | null }
    | { ok: true; didMaterialize: false; pendingQueueState: KnownPendingQueueState | null };

type AckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

type PendingMaterializePayload = Readonly<{ sid: string; pendingVersion?: number }>;

function readPendingMaterializePayload(payload: unknown): PendingMaterializePayload {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid pending queue materialize payload');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sid !== 'string') {
        throw new Error('Invalid pending queue materialize session id');
    }
    const pendingVersion = record.pendingVersion;
    return {
        sid: record.sid,
        ...(typeof pendingVersion === 'number' && Number.isSafeInteger(pendingVersion) && pendingVersion >= 0
            ? { pendingVersion }
            : {}),
    };
}

function createPendingMaterializeAckSocket(socket: Socket<ServerToClientEvents, ClientToServerEvents>): AckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): AckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== 'pending-materialize-next') {
                throw new Error(`Unexpected pending queue socket ACK event: ${event}`);
            }
            return await target.emitWithAck('pending-materialize-next', readPendingMaterializePayload(payload));
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function parseMaterializedMessageTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
}

function parseMaterializedMessage(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const seq = typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
        ? record.seq
        : null;
    if (seq === null) return null;
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
    const localId = typeof record.localId === 'string' && record.localId.length > 0 ? record.localId : null;
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
    };
}

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
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        return pending
            .map((row: unknown) => {
                if (!row || typeof row !== 'object') return null;
                const localId = (row as Record<string, unknown>).localId;
                return typeof localId === 'string' ? localId : null;
            })
            .filter((value: string | null): value is string => typeof value === 'string' && value.length > 0);
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
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
            throw error;
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
    knownPendingVersion?: number;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.knownPendingVersion === 'number' ? { pendingVersion: params.knownPendingVersion } : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object') return { ok: false };
        if (rawAck.ok !== true) return { ok: false };
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) return { ok: true, didMaterialize: false, pendingQueueState };
        const message = rawAck.message;
        const parsedMessage = parseMaterializedMessage(message);
        const localId = parsedMessage?.localId ?? (
            message && typeof message === 'object' && 'localId' in message && typeof message.localId === 'string'
                ? String(message.localId)
                : null
        );
        const didWrite = rawAck.didWrite === true;
        return { ok: true, didMaterialize: true, localId, didWrite, pendingQueueState, message: parsedMessage };
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
                'Content-Type': 'application/json',
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
    const pendingQueueState = readKnownPendingQueueState(data);
    if (data.didMaterialize !== true) return { ok: true, didMaterialize: false, pendingQueueState };
    const message = parseMaterializedMessage(data.message);
    const localId = message?.localId ?? (typeof data?.message?.localId === 'string' ? String(data.message.localId) : null);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    return { ok: true, didMaterialize: true, localId, didWrite, pendingQueueState, message };
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
            pendingQueueState: res.pendingQueueState,
            message: null,
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        pendingQueueState: res.pendingQueueState,
        message: res.message,
    };
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    knownPendingVersion?: number;
}): Promise<PendingQueueMaterializeNextResult> {
    const socketRes = params.socket.connected
        ? await tryMaterializeNextViaSocket({
            socket: params.socket,
            sessionId: params.sessionId,
            knownPendingVersion: params.knownPendingVersion,
        })
        : ({ ok: false } as const);
    const res = socketRes.ok ? socketRes : await tryMaterializeNextViaHttp({ token: params.token, sessionId: params.sessionId });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: res.pendingQueueState,
            message: null,
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        pendingQueueState: res.pendingQueueState,
        message: res.message,
    };
}
