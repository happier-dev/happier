import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
    readRpcErrorCode as readSessionRpcErrorCode,
} from '../runtime/rpcErrors';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { StopSessionResultSchema, type StopSessionResult } from '@happier-dev/protocol';
import { isRpcSessionMachineControlUnavailableError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readMachineControlTargetForSession, shouldFallbackFromMachineRpc } from './sessionMachineTarget';

type SessionKillRequest = Record<string, never>;

type LegacySessionKillResponse = Readonly<{
    success: boolean;
    message?: string;
    errorCode?: string;
}>;

export type DaemonMachineSessionStopAttempt =
    | Readonly<{ type: 'stopped' }>
    | Readonly<{ type: 'requested' }>
    | Readonly<{
        type: 'fallback';
        reason: 'not_found' | 'control_unavailable';
        message: string;
        errorCode?: string;
    }>
    | Readonly<{ type: 'failed'; message: string; errorCode?: string }>;

export type SessionStopStrategyOutcome =
    | Readonly<{ success: true; effect: 'process_stopped'; method: 'daemon_machine_rpc' | 'session_rpc' }>
    | Readonly<{
        success: false;
        failedAt: 'daemon_machine_rpc' | 'session_rpc';
        reason: 'requested';
        recovery: 'wait_for_inactive';
        message: string;
    }>
    | Readonly<{
        success: false;
        failedAt: 'daemon_machine_rpc' | 'session_rpc';
        reason: 'not_found';
        message: string;
    }>
    | Readonly<{
        success: false;
        failedAt: 'daemon_machine_rpc' | 'session_rpc';
        reason: 'control_unavailable';
        recovery: 'retry_when_runtime_available';
        message: string;
        errorCode?: string;
    }>
    | Readonly<{
        success: false;
        failedAt: 'daemon_machine_rpc' | 'session_rpc';
        reason: 'failed';
        message: string;
        errorCode?: string;
    }>;

function unknownErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
}

function readStrictStopSessionResult(response: unknown): StopSessionResult | null {
    const parsed = StopSessionResultSchema.safeParse(response);
    return parsed.success ? parsed.data : null;
}

function isReleasedMachineStopAcknowledgement(response: unknown): boolean {
    return Boolean(response)
        && typeof response === 'object'
        && (response as { message?: unknown }).message === 'Session stopped';
}

function readReleasedRunnerStopAcknowledgement(response: unknown): LegacySessionKillResponse | null {
    if (!response || typeof response !== 'object') return null;
    const candidate = response as { success?: unknown; message?: unknown; errorCode?: unknown };
    if (typeof candidate.success !== 'boolean') return null;
    return {
        success: candidate.success,
        ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
        ...(typeof candidate.errorCode === 'string' ? { errorCode: candidate.errorCode } : {}),
    };
}

function isDaemonSessionNotFoundOrFailedToStopMessage(message: string): boolean {
    return message === 'Session not found or failed to stop';
}

function readFallbackRpcErrorEnvelope(response: unknown): Readonly<{
    reason: 'control_unavailable';
    message: string;
    errorCode?: string;
}> | null {
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
        reason: 'control_unavailable',
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
            authorization: {
                kind: 'session.write',
                sessionId: params.sessionId,
            },
            serverId: params.serverId,
            // Stop is safe to reroute only before emission. Once issued, replaying the
            // same session id can terminate a replacement that resumed after the first exit.
            onIssued: () => {},
        });
        const strictResult = readStrictStopSessionResult(response);
        if (strictResult?.status === 'stopped') return { type: 'stopped' };
        if (strictResult?.status === 'requested') return { type: 'requested' };
        if (strictResult?.status === 'not_found') {
            return { type: 'fallback', reason: 'not_found', message: 'Session not found' };
        }
        if (strictResult?.status === 'incomplete') {
            return { type: 'failed', message: `Session stop incomplete: ${strictResult.reason}` };
        }
        if (isReleasedMachineStopAcknowledgement(response)) return { type: 'requested' };

        const fallbackEnvelope = readFallbackRpcErrorEnvelope(response);
        if (fallbackEnvelope) {
            return {
                type: 'fallback',
                reason: fallbackEnvelope.reason,
                message: fallbackEnvelope.message,
                ...(fallbackEnvelope.errorCode ? { errorCode: fallbackEnvelope.errorCode } : {}),
            };
        }
        return { type: 'failed', message: 'Unsupported response from machine RPC' };
    } catch (error) {
        const message = unknownErrorMessage(error);
        const errorCode = readRpcErrorCode(error);
        if (shouldFallbackFromMachineRpc(error) || isRpcSessionMachineControlUnavailableError(error)) {
            return {
                type: 'fallback',
                reason: 'control_unavailable',
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
}>): Promise<unknown> {
    try {
        return await sessionRpcWithServerScope<StopSessionResult | LegacySessionKillResponse, SessionKillRequest>({
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
            method: 'killSession',
            payload: {},
        });
    } catch (error) {
        const errorCode = readSessionRpcErrorCode(error);
        return {
            success: false,
            message: unknownErrorMessage(error),
            ...(errorCode ? { errorCode } : {}),
        };
    }
}

export async function stopSessionUsingCanonicalStrategy(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>): Promise<SessionStopStrategyOutcome> {
    let daemonFallback: Extract<DaemonMachineSessionStopAttempt, { type: 'fallback' }> | null = null;
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
        if (daemonStop.type === 'requested') {
            return {
                success: false,
                failedAt: 'daemon_machine_rpc',
                reason: 'requested',
                recovery: 'wait_for_inactive',
                message: 'Stop requested; waiting for the session to become inactive',
            };
        }
        if (daemonStop.type === 'failed') {
            return {
                success: false,
                failedAt: 'daemon_machine_rpc',
                reason: 'failed',
                message: daemonStop.message,
                ...(daemonStop.errorCode ? { errorCode: daemonStop.errorCode } : {}),
            };
        }
        daemonFallback = daemonStop;
    }

    const killResult = await stopSessionViaRunnerRpc({
        sessionId: params.sessionId,
        serverId: params.serverId ?? null,
    });
    const strictKillResult = readStrictStopSessionResult(killResult);
    if (strictKillResult?.status === 'stopped') {
        // A live runner can acknowledge a stop request, but cannot prove its own exit.
        return {
            success: false,
            failedAt: 'session_rpc',
            reason: 'requested',
            recovery: 'wait_for_inactive',
            message: 'Stop requested; waiting for the session to become inactive',
        };
    }
    if (strictKillResult?.status === 'requested') {
        return {
            success: false,
            failedAt: 'session_rpc',
            reason: 'requested',
            recovery: 'wait_for_inactive',
            message: 'Stop requested; waiting for the session to become inactive',
        };
    }
    if (strictKillResult?.status === 'not_found') {
        return { success: false, failedAt: 'session_rpc', reason: 'not_found', message: 'Session not found' };
    }
    if (strictKillResult?.status === 'incomplete') {
        return {
            success: false,
            failedAt: 'session_rpc',
            reason: 'failed',
            message: `Session stop incomplete: ${strictKillResult.reason}`,
        };
    }
    const releasedAcknowledgement = readReleasedRunnerStopAcknowledgement(killResult);
    if (releasedAcknowledgement?.success) {
        // Released runners acknowledge signal initiation using success:true.
        return {
            success: false,
            failedAt: 'session_rpc',
            reason: 'requested',
            recovery: 'wait_for_inactive',
            message: 'Stop requested; waiting for the session to become inactive',
        };
    }

    const message = releasedAcknowledgement?.message || 'Failed to stop session';
    const errorCode = releasedAcknowledgement?.errorCode;
    const rpcError = { rpcErrorCode: errorCode, message };
    if (isRpcMethodNotAvailableError(rpcError) || isRpcMethodNotFoundError(rpcError)) {
        if (daemonFallback?.reason === 'not_found') {
            return {
                success: false,
                failedAt: 'daemon_machine_rpc',
                reason: 'not_found',
                message: daemonFallback.message,
            };
        }
        return {
            success: false,
            failedAt: 'session_rpc',
            reason: 'control_unavailable',
            recovery: 'retry_when_runtime_available',
            message,
            ...(errorCode ? { errorCode } : {}),
        };
    }

    return {
        success: false,
        failedAt: 'session_rpc',
        reason: 'failed',
        message,
        ...(errorCode ? { errorCode } : {}),
    };
}
