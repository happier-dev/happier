import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
    readRpcErrorCode as readSessionRpcErrorCode,
} from '../runtime/rpcErrors';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerAccountScope, sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runWithHomeCredentialRequestSignal } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { serverFetch } from '@/sync/http/client';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { StopSessionResultSchema, type StopSessionResult } from '@happier-dev/protocol/sessionStop';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import type { SessionStopOutcome } from '@happier-dev/protocol/sessions/control/contract';
import { createRpcCallError, isRpcSessionMachineControlUnavailableError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readMachineControlTargetForSession, shouldFallbackFromMachineRpc } from './sessionMachineTarget';
import { log } from '@/log';

type SessionKillRequest = Record<string, never>;
type SessionStopFailureDiagnostics = Pick<Extract<StopSessionResult, { status: 'incomplete' }>,
    'failureCause' | 'effectAttempted' | 'processFailure'>;

type LegacySessionKillResponse = Readonly<{
    success: boolean;
    message?: string;
    errorCode?: string;
}>;

export type DaemonMachineSessionStopAttempt =
    | Readonly<{ type: 'stopped' }>
    | Readonly<{ type: 'requested' }>
    | Readonly<SessionStopFailureDiagnostics & {
        type: 'fallback';
        reason: 'not_found' | 'control_unavailable' | 'tracked_runner_absent';
        message: string;
        errorCode?: string;
    }>
    | Readonly<SessionStopFailureDiagnostics & { type: 'failed'; message: string; errorCode?: string }>;

export type SessionStopStrategyOutcome =
    | Readonly<{ success: true; effect: 'process_stopped'; method: 'daemon_machine_rpc' | 'session_rpc';
        stopOutcome?: Extract<SessionStopOutcome, { status: 'already_stopped' }> }>
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
    | Readonly<SessionStopFailureDiagnostics & {
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

function readSafeDiagnosticToken(value: unknown): string | undefined {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(value)) return undefined;
    return value;
}

function describeUnsupportedMachineStopResponse(response: unknown): Readonly<{
    type: string;
    keys?: readonly string[];
    status?: string;
    reason?: string;
}> {
    const type = response === null ? 'null' : Array.isArray(response) ? 'array' : typeof response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return { type };
    try {
        const record = response as Record<string, unknown>;
        const keys = Object.keys(record)
            .sort()
            .slice(0, 24)
            .map((key) => readSafeDiagnosticToken(key) ?? '<redacted_key>');
        const status = readSafeDiagnosticToken(record.status);
        const reason = readSafeDiagnosticToken(record.reason);
        return {
            type,
            keys,
            ...(status ? { status } : {}),
            ...(reason ? { reason } : {}),
        };
    } catch {
        return { type };
    }
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

/** An issued Stop belongs to its original Home credentials, independently of its mounted observer. */
async function observeSessionStopRequest<TResult>(params: Readonly<{
    serverId: string;
    signal?: AbortSignal;
    onIssued?: () => void;
    withdrawn: (issued: boolean) => TResult;
    request: (operation: Readonly<{ signal: AbortSignal; onIssued: () => void }>) => Promise<TResult>;
}>): Promise<TResult> {
    const observer = params.signal;
    if (observer?.aborted) return params.withdrawn(false);
    const beforeIssuance = new AbortController();
    let issued = false;
    const withdrawBeforeIssuance = () => { if (!issued) beforeIssuance.abort(); };
    observer?.addEventListener('abort', withdrawBeforeIssuance, { once: true });
    const operation = runWithHomeCredentialRequestSignal(params.serverId, async credentialSignal => {
        const cancellation = mergeAbortSignals([credentialSignal, beforeIssuance.signal]);
        try {
            return await params.request({ signal: cancellation.signal, onIssued: () => {
                issued = true;
                observer?.removeEventListener('abort', withdrawBeforeIssuance);
                params.onIssued?.();
            } });
        } finally { cancellation.dispose(); }
    }).finally(() => observer?.removeEventListener('abort', withdrawBeforeIssuance));
    if (!observer) return await operation;
    return await new Promise<TResult>((resolve, reject) => {
        const withdraw = () => { observer.removeEventListener('abort', withdraw); resolve(params.withdrawn(issued)); };
        observer.addEventListener('abort', withdraw, { once: true });
        operation.then(result => { observer.removeEventListener('abort', withdraw); resolve(result); },
            error => { observer.removeEventListener('abort', withdraw); reject(error); });
        if (observer.aborted) withdraw();
    });
}

export async function stopSessionViaDaemonMachineRpc(params: Readonly<{
    machineId: string;
    sessionId: string;
    serverId?: string | null;
    accountId?: string;
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<DaemonMachineSessionStopAttempt> {
    const serverId = params.serverId ?? getActiveServerSnapshot().serverId;
    if (!serverId) return { type: 'failed', message: 'action_home_not_found', errorCode: 'action_home_not_found' };
    return await observeSessionStopRequest<DaemonMachineSessionStopAttempt>({
        serverId, signal: params.signal, onIssued: params.onIssued,
        withdrawn: issued => issued ? { type: 'requested' }
            : { type: 'failed', message: 'Session Stop observation was withdrawn', errorCode: 'MACHINE_RPC_ABORTED' },
        request: operation => requestDaemonMachineSessionStop({ ...params, serverId, ...operation }),
    });
}

async function requestDaemonMachineSessionStop(params: Readonly<{
    machineId: string;
    sessionId: string;
    serverId?: string | null;
    accountId?: string;
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<DaemonMachineSessionStopAttempt> {
    let issued = false;
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
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
            // As in CLI Stop, retirement owns the operation lifetime. Keep route/setup
            // bounded, but do not expire an issued Stop at the generic RPC deadline.
            operationTimeoutMs: null,
            // Stop is safe to reroute only before emission. Once issued, replaying the
            // same session id can terminate a replacement that resumed after the first exit.
            onIssued: () => { issued = true; params.onIssued?.(); },
        });
        const strictResult = readStrictStopSessionResult(response);
        if (strictResult?.status === 'stopped') return { type: 'stopped' };
        if (strictResult?.status === 'requested') return { type: 'requested' };
        if (strictResult?.status === 'not_found') {
            return { type: 'fallback', reason: 'not_found', message: 'Session not found' };
        }
        if (strictResult?.status === 'incomplete') {
            if (strictResult.reason === 'tracked_runner_absent') {
                return {
                    type: 'fallback',
                    reason: 'tracked_runner_absent',
                    message: 'Session stop incomplete: tracked_runner_absent',
                    failureCause: strictResult.failureCause,
                    effectAttempted: strictResult.effectAttempted,
                    processFailure: strictResult.processFailure,
                };
            }
            return { type: 'failed', message: `Session stop incomplete: ${strictResult.reason}`,
                failureCause: strictResult.failureCause, effectAttempted: strictResult.effectAttempted,
                processFailure: strictResult.processFailure };
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
        if (
            response
            && typeof response === 'object'
            && !Array.isArray(response)
            && (response as { error?: unknown }).error === 'Forbidden'
            && (response as { errorCode?: unknown }).errorCode === RPC_ERROR_CODES.FORBIDDEN
        ) {
            // The released relay can surface the daemon's encrypted rejection as
            // the resolved inner result. Report that truthfully; never reinterpret
            // it as protocol support or fall back to a different stop authority.
            return {
                type: 'failed',
                message: 'Forbidden',
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            };
        }
        log.log(`[SESSION STOP] Unsupported machine RPC response ${JSON.stringify(
            describeUnsupportedMachineStopResponse(response),
        )}`);
        return issued ? { type: 'requested' }
            : { type: 'failed', message: 'Unsupported response from machine RPC' };
    } catch (error) {
        const message = unknownErrorMessage(error);
        const errorCode = readRpcErrorCode(error);
        // A lost reply does not revoke an issued Stop. Keep the existing
        // inactive-session reconciliation, and never try the runner as a replay.
        if (readRpcRequestDisposition(error) === 'outcomeUnknown' || errorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN) {
            return { type: 'requested' };
        }
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
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<unknown> {
    const serverId = params.scope?.serverId ?? params.serverId ?? getActiveServerSnapshot().serverId;
    if (!serverId) return { success: false, message: 'action_home_not_found', errorCode: 'action_home_not_found' };
    return await observeSessionStopRequest({
        serverId, signal: params.signal, onIssued: params.onIssued,
        withdrawn: issued => issued ? { status: 'requested' }
            : { success: false, message: 'Session Stop observation was withdrawn', errorCode: 'SOCKET_RPC_ABORTED' },
        request: operation => requestRunnerSessionStop({ ...params, serverId, ...operation }),
    });
}

async function requestRunnerSessionStop(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    onIssued: () => void;
}>): Promise<unknown> {
    try {
        const request = {
            sessionId: params.sessionId,
            method: 'killSession',
            payload: {},
            onIssued: params.onIssued,
            ...(params.signal ? { signal: params.signal } : {}),
        };
        return params.scope
            ? await sessionRpcWithServerAccountScope<StopSessionResult | LegacySessionKillResponse, SessionKillRequest>({ ...request, scope: params.scope })
            : await sessionRpcWithServerScope<StopSessionResult | LegacySessionKillResponse, SessionKillRequest>({ ...request, serverId: params.serverId ?? null });
    } catch (error) {
        const errorCode = readSessionRpcErrorCode(error);
        if (readRpcRequestDisposition(error) === 'outcomeUnknown' || errorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN) {
            return { status: 'requested' };
        }
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
    /** The original admitted Account; legacy Home-only callers do not recapture it. */
    scope?: ServerAccountScope;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
}>): Promise<SessionStopStrategyOutcome> {
    let daemonFallback: Extract<DaemonMachineSessionStopAttempt, { type: 'fallback' }> | null = null;
    const serverId = params.scope?.serverId ?? params.serverId ?? null;
    const assertCurrent = () => {
        params.signal?.throwIfAborted();
        if (params.isCurrent && !params.isCurrent()) {
            throw createRpcCallError({ error: 'action_account_scope_changed', errorCode: 'action_account_scope_changed' });
        }
    };
    const failed = (error: unknown, failedAt: 'daemon_machine_rpc' | 'session_rpc'): SessionStopStrategyOutcome => {
        const errorCode = error instanceof SessionSnapshotReadError ? error.errorCode : readRpcErrorCode(error);
        return { success: false, failedAt, reason: 'failed', message: unknownErrorMessage(error),
            ...(errorCode ? { errorCode } : {}) };
    };
    const readFreshSession = async () => {
        assertCurrent();
        if (!serverId) return null;
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({
            ...(params.scope ? { scope: params.scope } : { serverId }), activeRequest: serverFetch,
        }, async authority => {
            assertCurrent();
            return await readSessionSnapshotForAuthority({
                authority: { ...authority, request: async (path, init, options) => {
                    const cancellation = mergeAbortSignals([params.signal, init?.signal ?? undefined]);
                    try {
                        assertCurrent();
                        return await authority.request(path, { ...init, signal: cancellation.signal }, options);
                    } finally { cancellation.dispose(); }
                } },
                sessionId: params.sessionId,
                isCurrent: () => !params.signal?.aborted && (params.isCurrent?.() ?? true),
            });
        });
        assertCurrent();
        return session;
    };
    let machineTarget = readMachineControlTargetForSession(params.scope
        ? { ...params.scope, sessionId: params.sessionId }
        : serverId ? { serverId, sessionId: params.sessionId } : params.sessionId);
    try {
        assertCurrent();
        if (!machineTarget && params.serverId && params.scope) {
            // A route Home need not have published its private Session into the focused store.
            // Read through the existing exact-Account authority and keep this projection local.
            const session = await readFreshSession();
            if (session) {
                machineTarget = resolveMachineControlTargetForSessionFromState({
                    ...storage.getState(), sessions: { [params.sessionId]: session }, sessionListRowsByServerId: {},
                }, { ...params.scope, sessionId: params.sessionId });
            }
        }
        assertCurrent();
    } catch (error) {
        // A failed authority/read is not evidence that another stop authority is available.
        try { assertCurrent(); }
        catch (interruption) { return failed(interruption, 'daemon_machine_rpc'); }
        return failed(error, 'daemon_machine_rpc');
    }
    if (machineTarget) {
        const daemonStop = await stopSessionViaDaemonMachineRpc({
            machineId: machineTarget.machineId,
            sessionId: params.sessionId,
            serverId,
            ...(params.scope ? { accountId: params.scope.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
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
                failureCause: daemonStop.failureCause,
                effectAttempted: daemonStop.effectAttempted,
                processFailure: daemonStop.processFailure,
            };
        }
        if (daemonStop.reason === 'not_found') {
            try {
                // Exact daemon absence plus a fresh authoritative inactive Session
                // is the same confirmed-stop evidence used by the CLI owner.
                if ((await readFreshSession())?.active === false) {
                    return { success: true, effect: 'process_stopped', method: 'daemon_machine_rpc',
                        stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' } };
                }
            } catch (error) {
                try { assertCurrent(); }
                catch (interruption) { return failed(interruption, 'daemon_machine_rpc'); }
                // Unavailable confirmation retains the existing runner fallback;
                // it never upgrades an absent runtime into confirmed success.
                log.log('[SESSION STOP] Fresh inactive confirmation unavailable');
            }
        }
        daemonFallback = daemonStop;
    }

    try { assertCurrent(); }
    catch (error) { return failed(error, 'session_rpc'); }
    let runnerIssued = false;
    const killResult = await stopSessionViaRunnerRpc({
        sessionId: params.sessionId,
        serverId,
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        onIssued: () => { runnerIssued = true; },
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
            failureCause: strictKillResult.failureCause,
            effectAttempted: strictKillResult.effectAttempted,
            processFailure: strictKillResult.processFailure,
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

    if (!releasedAcknowledgement && runnerIssued) {
        // A malformed receipt cannot establish failure of an emitted effect.
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
        if (daemonFallback?.reason === 'tracked_runner_absent') {
            return {
                success: false,
                failedAt: 'daemon_machine_rpc',
                reason: 'failed',
                message: daemonFallback.message,
                failureCause: daemonFallback.failureCause,
                effectAttempted: daemonFallback.effectAttempted,
                processFailure: daemonFallback.processFailure,
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
