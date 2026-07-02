import axios from 'axios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { configuration } from '@/configuration';
import { resolveSessionControlSocketAckTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

import type { SessionClientDurableMutationSocket } from './sessionClientDurableMutationTypes';

function isSuccessAck(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.ok === true || record.result === 'success' || record.status === 'ok';
}

function isUnsupportedAck(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : typeof record.code === 'string' ? record.code : '';
    const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : '';
    return /unsupported|unknown|not[_ -]?found/i.test(code) || /unsupported|unknown event|not found/i.test(message);
}

function readUnsupportedAckCode(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : typeof record.code === 'string' ? record.code : '';
    return /unsupported|unknown|not[_ -]?found/i.test(code) ? code : undefined;
}

type UnsupportedSessionTurnSocketEvidence = Readonly<{
    transport: 'socket';
    evidence: 'unavailable' | 'unsupported_ack';
    code?: string;
}>;

type UnsupportedSessionTurnHttpEvidence = Readonly<{
    transport: 'http';
    evidence: 'unsupported_status';
    status: 404 | 405 | 501;
}>;

type SessionTurnMutationSocketResult =
    | Readonly<{ status: 'delivered' }>
    | Readonly<{ status: 'unsupported'; evidence: UnsupportedSessionTurnSocketEvidence }>
    | Readonly<{ status: 'failed' }>;

type SessionTurnMutationHttpResult =
    | Readonly<{ status: 'delivered' }>
    | Readonly<{ status: 'unsupported'; evidence: UnsupportedSessionTurnHttpEvidence }>
    | Readonly<{ status: 'incompatible'; statusCode: 400 | 422 }>
    | Readonly<{ status: 'failed' }>;

export type UnsupportedSessionTurnMutationDiagnostic = Readonly<{
    reason: 'session_turn_mutation_unsupported';
    serverOrigin: string;
    sessionId: string;
    mutationId: string;
    action: SessionTurnMutationV1['action'];
    turnId?: string;
    socket: UnsupportedSessionTurnSocketEvidence;
    http: UnsupportedSessionTurnHttpEvidence;
}>;

export type SessionTurnMutationDeliveryResult =
    | Readonly<{ delivered: true; path: 'socket' | 'http' }>
    | Readonly<{
        delivered: false;
        reason: 'unsupported_capability';
        diagnostic: UnsupportedSessionTurnMutationDiagnostic;
    }>
    | Readonly<{ delivered: false; reason: string }>;

function readHttpErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return null;
    const status = (response as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
}

function resolveServerOrigin(serverUrl: string): string {
    try {
        return new URL(serverUrl).origin;
    } catch {
        return 'configured-server';
    }
}

function buildUnsupportedDiagnostic(params: Readonly<{
    serverOrigin: string;
    mutation: SessionTurnMutationV1;
    socket: UnsupportedSessionTurnSocketEvidence;
    http: UnsupportedSessionTurnHttpEvidence;
}>): UnsupportedSessionTurnMutationDiagnostic {
    return {
        reason: 'session_turn_mutation_unsupported',
        serverOrigin: params.serverOrigin,
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        action: params.mutation.action,
        ...(params.mutation.turnId ? { turnId: params.mutation.turnId } : {}),
        socket: params.socket,
        http: params.http,
    };
}

async function trySocketSessionTurnMutation(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    mutation: SessionTurnMutationV1;
}>): Promise<SessionTurnMutationSocketResult> {
    if (params.socket.connected === false) return { status: 'unsupported', evidence: { transport: 'socket', evidence: 'unavailable' } };
    try {
        const socket = params.socket.timeout?.(resolveSessionControlSocketAckTimeoutMs()) ?? params.socket;
        if (typeof socket.emitWithAck !== 'function') {
            return { status: 'unsupported', evidence: { transport: 'socket', evidence: 'unavailable' } };
        }
        const ack = await socket.emitWithAck('session-turn-mutation', params.mutation);
        if (isSuccessAck(ack)) return { status: 'delivered' };
        if (isUnsupportedAck(ack)) {
            const code = readUnsupportedAckCode(ack);
            return {
                status: 'unsupported',
                evidence: {
                    transport: 'socket',
                    evidence: 'unsupported_ack',
                    ...(code ? { code } : {}),
                },
            };
        }
        return { status: 'failed' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return { status: 'failed' };
    }
}

async function tryHttpSessionTurnMutation(params: Readonly<{
    token: string;
    mutation: SessionTurnMutationV1;
    serverUrl: string;
}>): Promise<SessionTurnMutationHttpResult> {
    try {
        const response = await axios.post(
            `${params.serverUrl}/v1/sessions/${encodeURIComponent(params.mutation.sessionId)}/turns/mutations`,
            params.mutation,
            {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10_000,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (data && (data.ok === false || data.result === 'error')) return { status: 'failed' };
        return { status: 'delivered' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const status = readHttpErrorStatus(error);
        if (status === 404 || status === 405 || status === 501) {
            return { status: 'unsupported', evidence: { transport: 'http', evidence: 'unsupported_status', status } };
        }
        if (status === 400 || status === 422) return { status: 'incompatible', statusCode: status };
        return { status: 'failed' };
    }
}

export async function deliverSessionTurnMutation(params: Readonly<{
    token: string;
    socket: SessionClientDurableMutationSocket | null;
    mutation: SessionTurnMutationV1;
}>): Promise<SessionTurnMutationDeliveryResult> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    const socketResult = params.socket?.connected === true
        ? await trySocketSessionTurnMutation({ socket: params.socket, mutation: params.mutation })
        : { status: 'failed' as const };
    if (socketResult.status === 'delivered') return { delivered: true, path: 'socket' };

    const httpResult = await tryHttpSessionTurnMutation({
        token: params.token,
        mutation: params.mutation,
        serverUrl,
    });
    if (httpResult.status === 'delivered') return { delivered: true, path: 'http' };
    if (socketResult.status === 'unsupported' && httpResult.status === 'unsupported') {
        return {
            delivered: false,
            reason: 'unsupported_capability',
            diagnostic: buildUnsupportedDiagnostic({
                serverOrigin: resolveServerOrigin(serverUrl),
                mutation: params.mutation,
                socket: socketResult.evidence,
                http: httpResult.evidence,
            }),
        };
    }
    if (httpResult.status === 'incompatible') {
        return { delivered: false, reason: `incompatible_session_turn_mutation_http_${httpResult.statusCode}` };
    }
    return { delivered: false, reason: 'session_turn_mutation_transport_unavailable' };
}
