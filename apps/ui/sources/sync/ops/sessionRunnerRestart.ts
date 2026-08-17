import {
    RestartSessionRunnerRequestV1Schema,
    RestartSessionRunnerRequestV2Schema,
    RestartSessionRunnerResultV1Schema,
    SessionProviderBindingSecurityChangeConfirmationV1Schema,
    SessionRunnerRuntimeStateV1Schema,
    SessionRunnerRuntimeStatusV2Schema,
    SessionRunnerStatusGetRequestV1Schema,
    type RestartSessionRunnerResultV1,
    type SessionProviderBindingMetadataV1,
    type SessionRunnerRuntimeStateV1,
    type SessionRunnerProcessIdentityV2,
    type SessionRunnerStatusGetRequestV1,
} from '@happier-dev/protocol';
import {
    isRpcMethodNotFoundResult,
    RPC_ERROR_CODES,
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type RestartSessionRunnerInput = Readonly<{
    runtimeState: SessionRunnerRuntimeStateV1;
    serverId?: string | null;
}>;

export type RestartStaleSessionRunnerResult = RestartSessionRunnerResultV1;

type RestartSessionRunnerForProviderBindingChangeInput = RestartSessionRunnerInput & Readonly<{
    launchBinding?: SessionProviderBindingMetadataV1 | null;
    nextBindingSecurityFingerprint?: string | null;
    runnerProcessIdentity: SessionRunnerProcessIdentityV2 | null;
}>;

type GetSessionRunnerRuntimeStatusInput = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
}>;

export type FetchedSessionRunnerRuntimeStatus = Readonly<{
    state: SessionRunnerRuntimeStateV1;
    runnerProcessIdentity: SessionRunnerProcessIdentityV2 | null;
}>;

function buildResult(input: Readonly<{
    sessionId: string;
    status: RestartSessionRunnerResultV1['status'];
    reasonCode?: RestartSessionRunnerResultV1['reasonCode'];
    diagnostics?: RestartSessionRunnerResultV1['diagnostics'];
}>): RestartSessionRunnerResultV1 {
    return RestartSessionRunnerResultV1Schema.parse({
        ok: false,
        sessionId: input.sessionId,
        status: input.status,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
}

function isUnsupportedDaemonError(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
        return true;
    }
    if (error && typeof error === 'object') {
        const code = (error as { errorCode?: unknown; code?: unknown; status?: unknown }).errorCode
            ?? (error as { code?: unknown }).code
            ?? (error as { status?: unknown }).status;
        return code === RPC_ERROR_CODES.METHOD_NOT_FOUND
            || code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            || code === 'METHOD_NOT_FOUND'
            || code === 'METHOD_NOT_AVAILABLE';
    }
    return false;
}

function buildUnsupportedDaemonResult(sessionId: string): RestartSessionRunnerResultV1 {
    return buildResult({
        sessionId,
        status: 'unsupported_daemon',
        reasonCode: 'unsupported_daemon_version',
    });
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildVersionUnknownResult(
    sessionId: string,
    reasonCode: 'current_entrypoint_unknown' | 'runner_entrypoint_unknown',
): RestartSessionRunnerResultV1 {
    return buildResult({
        sessionId,
        status: 'version_unknown',
        reasonCode,
    });
}

function readRestartIdentityGuard(
    runtimeState: SessionRunnerRuntimeStateV1,
): Readonly<{
    expectedRunnerPid: number;
    expectedProcessCommandHash: string;
    expectedRunnerEntrypointIdentity: string;
}> | RestartSessionRunnerResultV1 {
    const expectedRunnerPid = runtimeState.runner.pid ?? null;
    if (expectedRunnerPid == null) {
        return buildResult({
            sessionId: runtimeState.sessionId,
            status: 'runner_not_active',
            reasonCode: 'no_tracked_process',
        });
    }

    const expectedProcessCommandHash = readNonEmptyString(runtimeState.runner.processCommandHash);
    if (!expectedProcessCommandHash) {
        return buildVersionUnknownResult(runtimeState.sessionId, 'runner_entrypoint_unknown');
    }

    const expectedRunnerEntrypointIdentity = runtimeState.runner.entrypointSource === 'unknown'
        ? null
        : readNonEmptyString(runtimeState.runner.runtimeId);
    if (!expectedRunnerEntrypointIdentity) {
        return buildVersionUnknownResult(runtimeState.sessionId, 'runner_entrypoint_unknown');
    }

    const currentEntrypointIdentity = runtimeState.daemon.currentEntrypointSource === 'unknown'
        ? null
        : readNonEmptyString(runtimeState.daemon.currentEntrypointVersion);
    if (!currentEntrypointIdentity) {
        return buildVersionUnknownResult(runtimeState.sessionId, 'current_entrypoint_unknown');
    }

    return {
        expectedRunnerPid,
        expectedProcessCommandHash,
        expectedRunnerEntrypointIdentity,
    };
}

async function sendSessionRunnerRestartRequest<Request>(input: RestartSessionRunnerInput & Readonly<{
    method:
        | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
        | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2;
    request: Request;
}>): Promise<RestartSessionRunnerResultV1> {
    const machineId = input.runtimeState.machineId?.trim() ?? '';
    if (machineId.length === 0) return buildUnsupportedDaemonResult(input.runtimeState.sessionId);
    try {
        const raw = await machineRpcWithServerScope<unknown, Request>({
            machineId,
            serverId: input.serverId ?? undefined,
            method: input.method,
            payload: input.request,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: input.runtimeState.sessionId,
            },
        });
        if (isRpcMethodNotFoundResult(raw) || isUnsupportedDaemonError(raw)) {
            return buildUnsupportedDaemonResult(input.runtimeState.sessionId);
        }

        const parsed = RestartSessionRunnerResultV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.sessionId !== input.runtimeState.sessionId) {
            return buildResult({
                sessionId: input.runtimeState.sessionId,
                status: 'partial_failure',
                diagnostics: { errorCode: 'invalid_response' },
            });
        }
        return parsed.data;
    } catch (error) {
        if (isUnsupportedDaemonError(error)) {
            return buildUnsupportedDaemonResult(input.runtimeState.sessionId);
        }
        return buildResult({
            sessionId: input.runtimeState.sessionId,
            status: 'partial_failure',
            diagnostics: {
                errorCode: error instanceof Error ? error.message : 'request_failed',
            },
        });
    }
}

async function requestSessionRunnerRestart(input: RestartSessionRunnerInput): Promise<RestartSessionRunnerResultV1> {
    const identityGuard = readRestartIdentityGuard(input.runtimeState);
    if ('ok' in identityGuard) return identityGuard;
    const request = RestartSessionRunnerRequestV1Schema.parse({
        sessionId: input.runtimeState.sessionId,
        mode: 'if_stale',
        reason: 'ui_stale_runner_banner',
        expectedRunnerPid: identityGuard.expectedRunnerPid,
        expectedProcessCommandHash: identityGuard.expectedProcessCommandHash,
        expectedRunnerEntrypointIdentity: identityGuard.expectedRunnerEntrypointIdentity,
    });
    return await sendSessionRunnerRestartRequest({
        ...input,
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
        request,
    });
}

export async function restartSessionRunnerOnCurrentRuntime(
    input: RestartSessionRunnerInput,
): Promise<RestartSessionRunnerResultV1> {
    return await requestSessionRunnerRestart(input);
}

export async function restartSessionRunnerForProviderBindingChange(
    input: RestartSessionRunnerForProviderBindingChangeInput,
): Promise<RestartSessionRunnerResultV1> {
    if (!input.runnerProcessIdentity) {
        return buildUnsupportedDaemonResult(input.runtimeState.sessionId);
    }
    const identityGuard = readRestartIdentityGuard(input.runtimeState);
    if ('ok' in identityGuard) return identityGuard;
    const nextFingerprint = readNonEmptyString(input.nextBindingSecurityFingerprint);
    const confirmation = input.launchBinding && nextFingerprint
        ? SessionProviderBindingSecurityChangeConfirmationV1Schema.parse({
            v: 1,
            sessionId: input.runtimeState.sessionId,
            connectionId: input.launchBinding.connectionId,
            previousBindingSecurityFingerprint: input.launchBinding.bindingSecurityFingerprint,
            nextBindingSecurityFingerprint: nextFingerprint,
        })
        : undefined;
    const request = RestartSessionRunnerRequestV2Schema.parse({
        v: 2,
        sessionId: input.runtimeState.sessionId,
        mode: 'force_current_cli',
        reason: 'provider_binding_change_recovery',
        expectedRunnerPid: identityGuard.expectedRunnerPid,
        expectedProcessCommandHash: identityGuard.expectedProcessCommandHash,
        expectedRunnerEntrypointIdentity: identityGuard.expectedRunnerEntrypointIdentity,
        expectedRunnerProcessIdentity: input.runnerProcessIdentity,
        ...(confirmation ? { providerBindingSecurityChangeConfirmationV1: confirmation } : {}),
    });
    return await sendSessionRunnerRestartRequest({
        runtimeState: input.runtimeState,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
        request,
    });
}

export async function getSessionRunnerRuntimeStatus(
    input: GetSessionRunnerRuntimeStatusInput,
): Promise<SessionRunnerRuntimeStateV1 | null> {
    return (await getSessionRunnerRuntimeStatusSnapshot(input))?.state ?? null;
}

async function getSessionRunnerRuntimeStatusV1Fallback(
    input: GetSessionRunnerRuntimeStatusInput,
    payload: SessionRunnerStatusGetRequestV1,
): Promise<FetchedSessionRunnerRuntimeStatus | null> {
    try {
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw) || isUnsupportedDaemonError(raw)) return null;
        const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.sessionId !== payload.sessionId) return null;
        return { state: parsed.data, runnerProcessIdentity: null };
    } catch {
        return null;
    }
}

export async function getSessionRunnerRuntimeStatusSnapshot(
    input: GetSessionRunnerRuntimeStatusInput,
): Promise<FetchedSessionRunnerRuntimeStatus | null> {
    const payload = SessionRunnerStatusGetRequestV1Schema.parse({
        sessionId: input.sessionId,
    } satisfies SessionRunnerStatusGetRequestV1);
    try {
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET,
            payload,
        });
        if (!isRpcMethodNotFoundResult(raw) && !isUnsupportedDaemonError(raw)) {
            const parsed = SessionRunnerRuntimeStatusV2Schema.safeParse(raw);
            if (parsed.success && parsed.data.state.sessionId === payload.sessionId) {
                return {
                    state: parsed.data.state,
                    runnerProcessIdentity: parsed.data.runnerProcessIdentity,
                };
            }
        }
    } catch {
        // Additive V2 may be absent on supported older daemons; V1 remains the status fallback.
    }
    return await getSessionRunnerRuntimeStatusV1Fallback(input, payload);
}
