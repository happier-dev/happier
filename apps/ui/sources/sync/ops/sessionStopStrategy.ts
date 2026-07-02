import { apiSocket } from '../api/session/apiSocket';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
    readRpcErrorCode as readSessionRpcErrorCode,
} from '../runtime/rpcErrors';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readMachineControlTargetForSession, shouldFallbackFromMachineRpc } from './sessionMachineTarget';

type SessionKillRequest = Record<string, never>;

type SessionKillResponse = Readonly<{
    success: boolean;
    message: string;
    errorCode?: string;
}>;

export type DaemonMachineSessionStopAttempt =
    | Readonly<{ type: 'stopped' }>
    | Readonly<{ type: 'fallback'; message: string; errorCode?: string }>
    | Readonly<{ type: 'failed'; message: string; errorCode?: string }>;

export type SessionStopStrategyOutcome =
    | Readonly<{ success: true; effect: 'process_stopped'; method: 'daemon_machine_rpc' | 'session_rpc' }>
    | Readonly<{ success: true; effect: 'server_marked_inactive'; method: 'session_end' }>
    | Readonly<{ success: false; failedAt: 'daemon_machine_rpc' | 'session_rpc' | 'session_end'; message: string; errorCode?: string }>;

function unknownErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
}

function hasMachineStopResponseShape(response: unknown): response is Readonly<{ message: string }> {
    return Boolean(response)
        && typeof response === 'object'
        && typeof (response as { message?: unknown }).message === 'string';
}

function isDaemonSessionNotFoundOrFailedToStopMessage(message: string): boolean {
    return message === 'Session not found or failed to stop';
}

function readFallbackRpcErrorEnvelope(response: unknown): Readonly<{ message: string; errorCode?: string }> | null {
    if (!response || typeof response !== 'object') return null;
    const envelope = response as { error?: unknown; errorCode?: unknown };
    if (typeof envelope.error !== 'string') return null;

    const carrier = {
        message: envelope.error,
        rpcErrorCode: typeof envelope.errorCode === 'string' ? envelope.errorCode : undefined,
    };
    if (
        !isRpcMethodNotAvailableError(carrier)
        && !isRpcMethodNotFoundError(carrier)
        && !isDaemonSessionNotFoundOrFailedToStopMessage(envelope.error)
    ) {
        return null;
    }

    return {
        message: envelope.error,
        ...(carrier.rpcErrorCode ? { errorCode: carrier.rpcErrorCode } : {}),
    };
}

export async function stopSessionViaDaemonMachineRpc(params: Readonly<{
    machineId: string;
    sessionId: string;
    serverId?: string | null;
}>): Promise<DaemonMachineSessionStopAttempt> {
    try {
        const response = await machineRpcWithServerScope<unknown, { sessionId: string }>({
            machineId: params.machineId,
            method: RPC_METHODS.STOP_SESSION,
            payload: { sessionId: params.sessionId },
            serverId: params.serverId,
        });
        if (!hasMachineStopResponseShape(response)) {
            const fallbackEnvelope = readFallbackRpcErrorEnvelope(response);
            if (fallbackEnvelope) {
                return {
                    type: 'fallback',
                    message: fallbackEnvelope.message,
                    ...(fallbackEnvelope.errorCode ? { errorCode: fallbackEnvelope.errorCode } : {}),
                };
            }
            return { type: 'failed', message: 'Unsupported response from machine RPC' };
        }
        return { type: 'stopped' };
    } catch (error) {
        const message = unknownErrorMessage(error);
        const errorCode = readRpcErrorCode(error);
        if (shouldFallbackFromMachineRpc(error)) {
            return {
                type: 'fallback',
                message,
                ...(errorCode ? { errorCode } : {}),
            };
        }
        return {
            type: 'failed',
            message,
            ...(errorCode ? { errorCode } : {}),
        };
    }
}

async function stopSessionViaRunnerRpc(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): Promise<SessionKillResponse> {
    try {
        const response = await sessionRpcWithServerScope<SessionKillResponse, SessionKillRequest>({
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
            method: 'killSession',
            payload: {},
        });
        return assertRpcResponseWithSuccess<SessionKillResponse>(response);
    } catch (error) {
        const errorCode = readSessionRpcErrorCode(error);
        return {
            success: false,
            message: unknownErrorMessage(error),
            ...(errorCode ? { errorCode } : {}),
        };
    }
}

async function markSessionInactiveViaSessionEnd(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): Promise<SessionStopStrategyOutcome> {
    try {
        const context = await resolveServerScopedSessionContext({ serverId: params.serverId ?? null });
        try {
            if (context.scope === 'active') {
                apiSocket.send('session-end', { sid: params.sessionId, time: Date.now() });
            } else {
                const socket = await createEphemeralServerSocketClient({
                    serverUrl: context.targetServerUrl,
                    token: context.token,
                    timeoutMs: context.timeoutMs,
                });
                try {
                    socket.emit('session-end', { sid: params.sessionId, time: Date.now() });
                } finally {
                    socket.disconnect();
                }
            }
        } catch {
            // Best-effort: server will also eventually time out stale sessions.
        }
        return { success: true, effect: 'server_marked_inactive', method: 'session_end' };
    } catch (error) {
        return {
            success: false,
            failedAt: 'session_end',
            message: unknownErrorMessage(error),
        };
    }
}

export async function stopSessionUsingCanonicalStrategy(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): Promise<SessionStopStrategyOutcome> {
    const machineTarget = readMachineControlTargetForSession(params.sessionId);
    if (machineTarget) {
        const daemonStop = await stopSessionViaDaemonMachineRpc({
            machineId: machineTarget.machineId,
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
        });
        if (daemonStop.type === 'stopped') {
            return { success: true, effect: 'process_stopped', method: 'daemon_machine_rpc' };
        }
        if (daemonStop.type === 'failed') {
            return {
                success: false,
                failedAt: 'daemon_machine_rpc',
                message: daemonStop.message,
                ...(daemonStop.errorCode ? { errorCode: daemonStop.errorCode } : {}),
            };
        }
    }

    const killResult = await stopSessionViaRunnerRpc({
        sessionId: params.sessionId,
        serverId: params.serverId ?? null,
    });
    if (killResult.success) {
        return { success: true, effect: 'process_stopped', method: 'session_rpc' };
    }

    const message = killResult.message || 'Failed to archive session';
    const isRpcMethodUnavailable = isRpcMethodNotAvailableError({
        rpcErrorCode: killResult.errorCode,
        message,
    });

    if (isRpcMethodUnavailable) {
        return await markSessionInactiveViaSessionEnd({
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
        });
    }

    return {
        success: false,
        failedAt: 'session_rpc',
        message,
        ...(killResult.errorCode ? { errorCode: killResult.errorCode } : {}),
    };
}
