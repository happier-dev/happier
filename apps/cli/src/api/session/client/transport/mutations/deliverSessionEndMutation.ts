import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { resolveSessionSnapshotRequestPurpose } from '@/api/session/sessionSnapshotRefreshReason';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { SessionEndAckResponseSchema } from '@happier-dev/protocol/updates';

import type {
    SessionClientDurableMutationSocket,
    SessionEndMutationV1,
} from './sessionClientDurableMutationTypes';

const DEFAULT_SESSION_END_DELIVERY_CONCURRENCY = 2;
const MAX_SESSION_END_DELIVERY_CONCURRENCY = 16;

let activeSessionEndDeliveries = 0;
const pendingSessionEndDeliverySlots: Array<() => void> = [];

function resolveSessionEndDeliveryConcurrency(): number {
    const raw = String(process.env.HAPPIER_SESSION_END_DELIVERY_CONCURRENCY ?? '').trim();
    if (!raw) return DEFAULT_SESSION_END_DELIVERY_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_SESSION_END_DELIVERY_CONCURRENCY;
    return Math.min(parsed, MAX_SESSION_END_DELIVERY_CONCURRENCY);
}

function drainPendingSessionEndDeliverySlots(): void {
    const limit = resolveSessionEndDeliveryConcurrency();
    while (activeSessionEndDeliveries < limit) {
        const resolve = pendingSessionEndDeliverySlots.shift();
        if (!resolve) return;
        activeSessionEndDeliveries += 1;
        resolve();
    }
}

/** Test-only counterpart of the durable delivery limiter's reset; see that owner. */
export function resetSessionEndDeliverySlotsForTests(): void {
    activeSessionEndDeliveries = 0;
    const waiting = pendingSessionEndDeliverySlots.splice(0, pendingSessionEndDeliverySlots.length);
    for (const resolve of waiting) resolve();
}

async function acquireSessionEndDeliverySlot(): Promise<void> {
    if (activeSessionEndDeliveries < resolveSessionEndDeliveryConcurrency()) {
        activeSessionEndDeliveries += 1;
        return;
    }
    await new Promise<void>((resolve) => {
        pendingSessionEndDeliverySlots.push(resolve);
    });
}

async function withSessionEndDeliverySlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquireSessionEndDeliverySlot();
    try {
        return await fn();
    } finally {
        activeSessionEndDeliveries = Math.max(0, activeSessionEndDeliveries - 1);
        drainPendingSessionEndDeliverySlots();
    }
}

function isUnsupportedHttpError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const directStatus = (error as { status?: unknown }).status;
    if (directStatus === 404 || directStatus === 405 || directStatus === 501) return true;
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_BAD_REQUEST' || code === 'ERR_BAD_RESPONSE') {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && /\b(404|405|501)\b/.test(message)) return true;
    }
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return false;
    const status = (response as { status?: unknown }).status;
    return status === 404 || status === 405 || status === 501;
}

type SessionEndDisposition = 'settled' | 'current' | 'unavailable';

function readSessionEndDisposition(value: unknown, mutation: SessionEndMutationV1): SessionEndDisposition {
    if (!value || typeof value !== 'object') return 'unavailable';
    const record = value as Record<string, unknown>;
    if (record.id !== mutation.sessionId) return 'unavailable';
    if (record.active === false) return 'settled';
    if (record.active !== true || typeof record.activeAt !== 'number'
        || !Number.isSafeInteger(record.activeAt) || record.activeAt < 0) return 'unavailable';
    // A retained end belongs to the publisher that authored it. Resuming after
    // that observation supersedes it; a refreshed legacy timestamp must never
    // turn it into an end of the new publisher.
    return record.activeAt > mutation.observedAt ? 'settled' : 'current';
}

function readSessionEndProof(body: unknown, mutation: SessionEndMutationV1): SessionEndDisposition {
    if (!body || typeof body !== 'object') return 'unavailable';
    const record = body as Record<string, unknown>;
    const direct = readSessionEndDisposition(record.session, mutation);
    if (direct !== 'unavailable') return direct;
    const sessions = record.sessions;
    if (Array.isArray(sessions)) {
        for (const session of sessions) {
            const disposition = readSessionEndDisposition(session, mutation);
            if (disposition !== 'unavailable') return disposition;
        }
    }
    return 'unavailable';
}

async function trySocketAckSessionEnd(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    payload: Readonly<{ sid: string; time: number; exit?: unknown }>;
}>): Promise<boolean> {
    if (params.socket.connected !== true) return false;
    try {
        const socket = params.socket.timeout?.(10_000) ?? params.socket;
        if (typeof socket.emitWithAck !== 'function') return false;
        const raw = await emitSocketWithAck({
            socket,
            event: 'session-end',
            payload: params.payload,
        });
        const parsed = SessionEndAckResponseSchema.safeParse(raw);
        return parsed.success && parsed.data.ok === true;
    } catch {
        return false;
    }
}

async function fetchSessionEndProof(params: Readonly<{
    serverUrl: string;
    token: string;
    mutation: SessionEndMutationV1;
}>): Promise<SessionEndDisposition> {
    const headers = {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.token}`,
        'X-Happier-Request-Purpose': resolveSessionSnapshotRequestPurpose('legacy-compat-proof'),
    };
    const urls = [
        `${params.serverUrl}/v2/sessions/${encodeURIComponent(params.mutation.sessionId)}`,
        `${params.serverUrl}/v1/sessions`,
    ];
    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                headers,
                timeout: 10_000,
            });
            const disposition = readSessionEndProof(response?.data, params.mutation);
            if (disposition !== 'unavailable') return disposition;
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
        }
    }
    return 'unavailable';
}

export async function deliverSessionEndMutation(params: Readonly<{
    token: string;
    socket: SessionClientDurableMutationSocket | null;
    mutation: SessionEndMutationV1;
}>): Promise<boolean> {
    return await withSessionEndDeliverySlot(async () => {
        const serverUrl = resolveServerHttpBaseUrl();
        try {
            const response = await axios.post(
                `${serverUrl}/v1/sessions/${encodeURIComponent(params.mutation.sessionId)}/end`,
                { time: params.mutation.observedAt },
                {
                    headers: {
                        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        Authorization: `Bearer ${params.token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10_000,
                },
            );
            const data = response?.data as Record<string, unknown> | undefined;
            return !(data && (
                data.ok === false
                || data.result === 'error'
                || data.success === false
            ));
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            if (isUnsupportedHttpError(error)) {
                const proof = { serverUrl, token: params.token, mutation: params.mutation };
                const disposition = await fetchSessionEndProof(proof);
                if (disposition === 'settled') return true;
                if (disposition !== 'current') return false;
                // Released v0.2.1 accepts this unacknowledged compatibility event only
                // within a bounded wall-clock window. Keep the durable observation
                // immutable, but timestamp each legacy delivery attempt so it remains
                // admissible; refreshed server state still supplies the clearing proof.
                const payload = {
                    sid: params.mutation.sessionId,
                    time: Date.now(),
                    ...(params.mutation.exit !== undefined ? { exit: params.mutation.exit } : {}),
                };
                if (params.socket?.connected === true) {
                    if (await trySocketAckSessionEnd({ socket: params.socket, payload })) {
                        return true;
                    }
                    params.socket.emit('session-end', payload);
                    return await fetchSessionEndProof(proof) === 'settled';
                }
                return false;
            }
            return false;
        }
    });
}
