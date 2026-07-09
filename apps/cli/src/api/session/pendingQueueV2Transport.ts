import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    normalizePendingDeliveryBlockedReason,
    normalizePendingDeliveryStatusV1,
    parsePendingDeliveryStatusV1,
    SessionMessageRoleSchema,
    type PendingDeliveryBlockedReason,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';

export type PendingMaterializationDeliveryTiming = 'after_runtime_idle';

export type PendingMaterializationProviderDeliveryState = Readonly<{
    mode: 'provider';
    unresolved: boolean;
}>;

export type PendingMaterializationAwaitingRuntimeIdleDeliveryState = Readonly<{
    mode: 'awaiting_runtime_idle';
    unresolved: true;
}>;

export type PendingMaterializationDeliveryState =
    | PendingMaterializationProviderDeliveryState
    | PendingMaterializationAwaitingRuntimeIdleDeliveryState;

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number | null;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
    deliveryStateMalformed?: boolean;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    pendingQueueState: KnownPendingQueueState | null;
    message: PendingQueueMaterializedMessage | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
};

type PendingQueueWriteBody = Readonly<
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole }
>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; pendingQueueState: KnownPendingQueueState | null; message: PendingQueueMaterializedMessage | null }
    | { ok: true; didMaterialize: false; pendingQueueState: KnownPendingQueueState | null; deliveryState: PendingMaterializationDeliveryState | null }
    | { ok: false };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; pendingQueueState: KnownPendingQueueState | null; message: PendingQueueMaterializedMessage | null }
    | { ok: true; didMaterialize: false; pendingQueueState: KnownPendingQueueState | null; deliveryState: PendingMaterializationDeliveryState | null };

type AckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

type PendingMaterializePayload = Readonly<{
    sid: string;
    pendingVersion?: number;
    deliveryState?: 'provider';
    deliveryTiming?: PendingMaterializationDeliveryTiming;
}>;

export type PendingQueueDeliveryBlockedReason = PendingDeliveryBlockedReason;

export type PendingQueueBlockedDelivery = Readonly<{
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}>;

function readResolvedLocalIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const rawLocalIds = (value as Record<string, unknown>).resolvedLocalIds;
    if (!Array.isArray(rawLocalIds)) return [];
    const resolvedLocalIds: string[] = [];
    for (const rawLocalId of rawLocalIds) {
        const localId = typeof rawLocalId === 'string' ? rawLocalId.trim() : '';
        if (!localId || resolvedLocalIds.includes(localId)) continue;
        resolvedLocalIds.push(localId);
    }
    return resolvedLocalIds;
}

function readPendingDeliveryStatusFromRecord(record: Record<string, unknown>) {
    return parsePendingDeliveryStatusV1(record.deliveryStatus)
        ?? normalizePendingDeliveryStatusV1({
            status: record.status,
            deliveryState: record.deliveryState,
            deliveryBlockedReason: record.deliveryBlockedReason,
            discardedReason: record.discardedReason,
        });
}

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
        ...(record.deliveryState === 'provider' ? { deliveryState: 'provider' } : {}),
        ...(record.deliveryTiming === 'after_runtime_idle' ? { deliveryTiming: 'after_runtime_idle' } : {}),
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

function parseDeliveryState(value: unknown): {
    deliveryState: PendingMaterializationDeliveryState | null;
    malformed: boolean;
} {
    if (value === null || value === undefined) {
        return { deliveryState: null, malformed: false };
    }
    if (!value || typeof value !== 'object') {
        return { deliveryState: null, malformed: true };
    }
    const record = value as Record<string, unknown>;
    if (record.mode === 'awaiting_runtime_idle' && record.unresolved === true) {
        return {
            deliveryState: {
                mode: 'awaiting_runtime_idle',
                unresolved: true,
            },
            malformed: false,
        };
    }
    if (record.mode !== 'provider' || typeof record.unresolved !== 'boolean') {
        return { deliveryState: null, malformed: true };
    }
    return {
        deliveryState: {
            mode: 'provider',
            unresolved: record.unresolved,
        },
        malformed: false,
    };
}

function parseMaterializedMessage(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const seq = record.seq === null
        ? null
        : typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
            ? record.seq
            : undefined;
    if (seq === undefined) return null;
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
    const localId = typeof record.localId === 'string' && record.localId.length > 0 ? record.localId : null;
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    const deliveryState = parseDeliveryState(record.deliveryState);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
        deliveryState: deliveryState.deliveryState,
        ...(deliveryState.malformed ? { deliveryStateMalformed: true } : {}),
    };
}

function readMaterializedMessageFromAck(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const parsedMessage = parseMaterializedMessage(record.message);
    const topLevelDeliveryState = parseDeliveryState(record.deliveryState);
    if (parsedMessage) {
        return {
            ...parsedMessage,
            deliveryState: parsedMessage.deliveryState ?? topLevelDeliveryState.deliveryState,
            ...(parsedMessage.deliveryStateMalformed || topLevelDeliveryState.malformed
                ? { deliveryStateMalformed: true }
                : {}),
        };
    }
    return parseMaterializedMessage(record);
}

function readMaterializedLocalIdFromAck(value: unknown, message: PendingQueueMaterializedMessage | null): string | null {
    if (message?.localId) return message.localId;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.localId === 'string' && record.localId.length > 0) return record.localId;
    const nested = record.message;
    if (!nested || typeof nested !== 'object') return null;
    const nestedLocalId = (nested as Record<string, unknown>).localId;
    return typeof nestedLocalId === 'string' && nestedLocalId.length > 0 ? nestedLocalId : null;
}

class PendingProviderDeliveryMaterializationContractError extends Error {
    constructor() {
        super('Invalid pending provider delivery materialize response');
        this.name = 'PendingProviderDeliveryMaterializationContractError';
    }
}

function readProviderClaimLocalId(message: PendingQueueMaterializedMessage | null, fallbackLocalId: string | null): string | null {
    if (typeof message?.localId === 'string' && message.localId.length > 0) {
        return message.localId;
    }
    return typeof fallbackLocalId === 'string' && fallbackLocalId.length > 0 ? fallbackLocalId : null;
}

function assertProviderDeliveryClaimMaterialization(params: {
    didWrite: boolean;
    message: PendingQueueMaterializedMessage | null;
    localId: string | null;
}): void {
    const message = params.message;
    const localId = readProviderClaimLocalId(message, params.localId);
    if (
        params.didWrite === true
        && message
        && typeof message.id === 'string'
        && message.id.length > 0
        && typeof message.seq === 'number'
        && Number.isSafeInteger(message.seq)
        && message.seq >= 0
        && localId !== null
        && message.deliveryStateMalformed !== true
        && message.deliveryState?.mode === 'provider'
        && message.deliveryState.unresolved === true
    ) {
        return;
    }
    if (
        params.didWrite === false
        && message
        && message.seq === null
        && localId !== null
        && message.deliveryStateMalformed === true
    ) {
        return;
    }
    if (
        params.didWrite === false
        && message
        && message.seq === null
        && localId !== null
        && message.deliveryStateMalformed !== true
        && (
            !message.deliveryState
            || message.deliveryState.mode === 'provider'
        )
    ) {
        return;
    }
    throw new PendingProviderDeliveryMaterializationContractError();
}

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
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

export async function listPendingQueueV2ProviderDeliveryLocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        const seen = new Set<string>();
        const localIds: string[] = [];
        for (const row of pending) {
            if (!row || typeof row !== 'object') continue;
            const record = row as Record<string, unknown>;
            const localId = record.localId;
            const deliveryStatus = readPendingDeliveryStatusFromRecord(record);
            if (
                typeof localId !== 'string'
                || localId.length === 0
                || seen.has(localId)
                || record.status === 'discarded'
                || deliveryStatus.status !== 'delivering'
            ) {
                continue;
            }
            seen.add(localId);
            localIds.push(localId);
        }
        return localIds;
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function readBlockedPendingQueueV2DeliveryByLocalIdFromServer(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<PendingQueueBlockedDelivery | null> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        for (const row of pending) {
            if (!row || typeof row !== 'object') continue;
            const record = row as Record<string, unknown>;
            const localId = record.localId;
            const deliveryStatus = readPendingDeliveryStatusFromRecord(record);
            if (
                localId !== params.localId
                || record.status === 'discarded'
                || deliveryStatus.status !== 'blocked'
            ) {
                continue;
            }
            const reason = deliveryStatus.reason ?? normalizePendingDeliveryBlockedReason(record.deliveryBlockedReason);
            return reason ? { localId: params.localId, reason } : null;
        }
        return null;
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
    const serverUrl = resolveServerHttpBaseUrl();
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
    const serverUrl = resolveServerHttpBaseUrl();
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

export async function resolveAcceptedPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'accepted',
        body: {},
    });
}

export async function reconcileAcceptedPendingQueueV2DeliveriesThroughSeq(params: {
    token: string;
    sessionId: string;
    maxAcceptedSeq: number;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; resolvedLocalIds: string[] }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/delivery/accepted-through-seq`,
        { maxAcceptedSeq: params.maxAcceptedSeq },
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
        throw new Error('Invalid pending delivery accepted-through-seq response');
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery accepted-through-seq failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    return {
        ...(pendingQueueState ? { pendingQueueState } : {}),
        resolvedLocalIds: readResolvedLocalIds(data),
    };
}

export async function blockPendingQueueV2ProviderDeliveriesOnAttach(params: {
    token: string;
    sessionId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/delivery/provider-attach`,
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
        throw new Error('Invalid pending delivery provider-attach response');
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery provider-attach failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    return pendingQueueState ? { pendingQueueState } : {};
}

export async function blockPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'block',
        body: { reason: params.reason },
    });
}

export async function retryPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'retry',
        body: {},
    });
}

export async function markPendingQueueV2DeliveryHandled(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'handled',
        body: {},
    });
}

async function postPendingQueueV2DeliveryAction(params: {
    token: string;
    sessionId: string;
    localId: string;
    action: 'accepted' | 'block' | 'retry' | 'handled';
    body: Record<string, unknown>;
}): Promise<{ pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/${encodeURIComponent(params.localId)}/delivery/${params.action}`,
        params.body,
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
        throw new Error(`Invalid pending delivery ${params.action} response`);
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery ${params.action} failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    const message = params.action === 'accepted' ? readMaterializedMessageFromAck(data) : null;
    return {
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...(params.action === 'accepted' ? { message } : {}),
    };
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.knownPendingVersion === 'number' ? { pendingVersion: params.knownPendingVersion } : {}),
                ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
                ...(params.deliveryTiming === 'after_runtime_idle' ? { deliveryTiming: 'after_runtime_idle' } : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object') return { ok: false };
        if (rawAck.ok !== true) return { ok: false };
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) {
            return {
                ok: true,
                didMaterialize: false,
                pendingQueueState,
                deliveryState: parseDeliveryState(rawAck.deliveryState).deliveryState,
            };
        }
        const parsedMessage = readMaterializedMessageFromAck(rawAck);
        const localId = readMaterializedLocalIdFromAck(rawAck, parsedMessage);
        const didWrite = rawAck.didWrite === true;
        if (params.deliveryStateOptIn === true) {
            assertProviderDeliveryClaimMaterialization({ didWrite, message: parsedMessage, localId });
        }
        return { ok: true, didMaterialize: true, localId, didWrite, pendingQueueState, message: parsedMessage };
    } catch (error) {
        if (error instanceof PendingProviderDeliveryMaterializationContractError || isAuthenticationError(error)) {
            throw error;
        }
        return { ok: false };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const body = {
        ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
        ...(params.deliveryTiming === 'after_runtime_idle' ? { deliveryTiming: 'after_runtime_idle' } : {}),
    };
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        body,
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
    if (data.didMaterialize !== true) {
        return {
            ok: true,
            didMaterialize: false,
            pendingQueueState,
            deliveryState: parseDeliveryState(data.deliveryState).deliveryState,
        };
    }
    const message = readMaterializedMessageFromAck(data);
    const localId = readMaterializedLocalIdFromAck(data, message);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    if (params.deliveryStateOptIn === true) {
        assertProviderDeliveryClaimMaterialization({ didWrite, message, localId });
    }
    return { ok: true, didMaterialize: true, localId, didWrite, pendingQueueState, message };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
}): Promise<PendingQueueMaterializeNextResult> {
    const res = await tryMaterializeNextViaHttp({
        ...params,
        deliveryStateOptIn: params.deliveryStateOptIn === true,
    });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: res.pendingQueueState,
            message: null,
            deliveryState: res.deliveryState,
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
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
}): Promise<PendingQueueMaterializeNextResult> {
    const socketRes = params.socket.connected
        ? await tryMaterializeNextViaSocket({
            socket: params.socket,
            sessionId: params.sessionId,
            knownPendingVersion: params.knownPendingVersion,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
        })
        : ({ ok: false } as const);
    let res: PendingQueueSocketMaterializeResult | PendingQueueHttpMaterializeResult;
    if (socketRes.ok) {
        res = socketRes;
    } else {
        res = await tryMaterializeNextViaHttp({
            token: params.token,
            sessionId: params.sessionId,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
        });
    }
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: res.pendingQueueState,
            message: null,
            deliveryState: res.deliveryState,
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
