import { buildSessionRunnerRuntimeRefreshRequestV1, projectSessionRunnerReadFailureV1, RestartSessionRunnerResultV1Schema, type RestartSessionRunnerResultV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { buildSessionRunnerProviderBindingRestartRequestV2 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV2';
import type { SessionProviderBindingSecurityChangeConfirmationV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { readSessionRunnerRuntimeStateForRestartV1, SessionRunnerRuntimeStateV1Schema, SessionRunnerStatusGetRequestV1Schema, type SessionRunnerRuntimeStateV1, type SessionRunnerStatusGetRequestV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { SessionRunnerRuntimeStatusV2Schema, type SessionRunnerProcessIdentityV2 } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV2';
import {
    isRpcMethodNotFoundResult,
    RPC_ERROR_CODES,
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import { delay } from '@/utils/timing/time';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/connectionManager';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { hasActiveSessionRuntimeActivity } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { t } from '@/text';

type RestartSessionRunnerInput = Readonly<{
    runtimeState: SessionRunnerRuntimeStateV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type RestartStaleSessionRunnerResult = RestartSessionRunnerResultV1;

type RestartSessionRunnerForProviderBindingChangeInput = RestartSessionRunnerInput & Readonly<{
    providerBindingSecurityChangeConfirmationV1?: SessionProviderBindingSecurityChangeConfirmationV1;
    runnerProcessIdentity: SessionRunnerProcessIdentityV2 | null;
}>;

type GetSessionRunnerRuntimeStatusInput = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
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
    return projectSessionRunnerReadFailureV1('status-read', error).status === 'unsupported_daemon';
}

function isRestartMethodUnavailable(error: unknown): boolean {
    const code = projectSessionRunnerReadFailureV1('restart', error).diagnostics?.errorCode;
    return code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || code === 'METHOD_NOT_AVAILABLE';
}

function buildUnsupportedDaemonResult(sessionId: string): RestartSessionRunnerResultV1 {
    return buildResult({
        sessionId,
        status: 'unsupported_daemon',
        reasonCode: 'unsupported_daemon_version',
    });
}

// Preserve the source restart owner's observation policy for delayed daemon publication.
const SESSION_RUNNER_RESTART_OBSERVE_ATTEMPTS = 8;
const SESSION_RUNNER_RESTART_OBSERVE_INTERVAL_MS = 1_500;

async function sendSessionRunnerRestartRequest<Request>(input: RestartSessionRunnerInput & Readonly<{
    method:
        | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
        | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2
        | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_CONFIRMED_BACKGROUND;
    fallbackMethod?: typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2;
    request: Request;
    reconcileMode?: 'if_stale' | 'force_current_cli';
}>): Promise<RestartSessionRunnerResultV1> {
    input.signal?.throwIfAborted();
    const machineId = input.runtimeState.machineId?.trim() ?? '';
    if (machineId.length === 0) return projectSessionRunnerReadFailureV1(input.runtimeState.sessionId, null);
    const unsupported = () => input.fallbackMethod
        ? sendSessionRunnerRestartRequest({ ...input, method: input.fallbackMethod, fallbackMethod: undefined })
        : Promise.resolve(buildUnsupportedDaemonResult(input.runtimeState.sessionId));
    let result: RestartSessionRunnerResultV1;
    try {
        const raw = await machineRpcWithServerScope<unknown, Request>({
            machineId,
            serverId: input.serverId ?? undefined,
            method: input.method,
            payload: input.request,
            // Child work can defer replacement; caller cancellation owns this wait.
            operationTimeoutMs: null,
            ...(input.signal ? { signal: input.signal } : {}),
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: input.runtimeState.sessionId,
            },
        });
        if (isUnsupportedDaemonError(raw) || (input.fallbackMethod && isRestartMethodUnavailable(raw))
            || (!input.fallbackMethod && isRpcMethodNotFoundResult(raw))) {
            return await unsupported();
        }

        const parsed = RestartSessionRunnerResultV1Schema.safeParse(raw);
        result = parsed.success && parsed.data.sessionId === input.runtimeState.sessionId
            ? parsed.data : projectSessionRunnerReadFailureV1(input.runtimeState.sessionId, raw);
    } catch (error) {
        input.signal?.throwIfAborted();
        if (isUnsupportedDaemonError(error) || (input.fallbackMethod && isRestartMethodUnavailable(error))) {
            return await unsupported();
        }
        result = projectSessionRunnerReadFailureV1(input.runtimeState.sessionId, error);
    }

    // Exact-process replacement cannot prove that a requested provider binding was
    // applied: V2 runtime status carries no binding evidence. Keep that failure closed.
    if (result.diagnostics?.errorCode === RPC_ERROR_CODES.FORBIDDEN
        || result.diagnostics?.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return result;
    if (!input.reconcileMode || result.ok || ![
        'partial_failure', 'stop_failed', 'spawn_failed', 'runner_identity_changed', 'not_found',
    ].includes(result.status)) return result;

    for (let attempt = 0; attempt < SESSION_RUNNER_RESTART_OBSERVE_ATTEMPTS; attempt += 1) {
        input.signal?.throwIfAborted();
        const state = await getSessionRunnerRuntimeStatus({
            sessionId: input.runtimeState.sessionId,
            machineId,
            serverId: input.serverId,
            signal: input.signal,
        });
        const replaced = state?.runner.pid != null && state.runner.pid !== input.runtimeState.runner.pid;
        const landed = replaced || (input.reconcileMode === 'if_stale' && state?.versionState === 'current');
        if (landed) {
            return { ok: true, status: 'restarted', sessionId: input.runtimeState.sessionId };
        }
        if (attempt < SESSION_RUNNER_RESTART_OBSERVE_ATTEMPTS - 1) {
            await delay(SESSION_RUNNER_RESTART_OBSERVE_INTERVAL_MS);
        }
    }
    return result;
}

// One open confirmation protects repeated presses across every UI runner restart.
let backgroundWorkConfirmationOpen = false;

function readRunnerRestartSessionActivity(input: RestartSessionRunnerInput) {
    const state = storage.getState();
    const activeServerId = getAppliedActiveServerSnapshot().serverId;
    const serverId = resolveMachineRpcTargetServerId(input.serverId);
    return selectHomeQualifiedSession(state, input.runtimeState.sessionId, serverId, activeServerId)
        ?? readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, input.runtimeState.sessionId);
}

async function confirmRunnerRestartStopsBackgroundWork(input: RestartSessionRunnerInput): Promise<boolean> {
    input.signal?.throwIfAborted();
    if (backgroundWorkConfirmationOpen) return false;
    backgroundWorkConfirmationOpen = true;
    try {
        const count = readRunnerRestartSessionActivity(input)?.runtimeActivityActiveCount ?? 0;
        const confirmed = await Modal.confirm(
            t('session.runnerRestartBackgroundWork.title'),
            t('session.runnerRestartBackgroundWork.body', { count }),
            { cancelText: t('common.cancel'), confirmText: t('session.runnerRestartBackgroundWork.confirmAction'),
                destructive: true },
        );
        input.signal?.throwIfAborted();
        return confirmed;
    } finally {
        backgroundWorkConfirmationOpen = false;
    }
}

async function restartSessionRunnerWithBackgroundWorkConfirmation<Request>(input: RestartSessionRunnerInput & Readonly<{
    method: typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART | typeof RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2;
    request: Request;
    reconcileMode?: 'if_stale' | 'force_current_cli';
}>): Promise<RestartSessionRunnerResultV1 | null> {
    input.signal?.throwIfAborted();
    const session = readRunnerRestartSessionActivity(input);
    // Interruption protection reads the reported fact even when presentation is stale or foregrounded.
    const hasActivity = hasActiveSessionRuntimeActivity({
        state: session?.runtimeActivityState, activeCount: session?.runtimeActivityActiveCount,
    });
    if (hasActivity && !await confirmRunnerRestartStopsBackgroundWork(input)) return null;
    const restart = (confirmed: boolean) => sendSessionRunnerRestartRequest({ ...input,
        method: confirmed ? RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_CONFIRMED_BACKGROUND : input.method,
        // Supported older daemons receive the unchanged original request only after the same consent.
        ...(confirmed ? { fallbackMethod: input.method } : {}),
    });
    const result = await restart(hasActivity);
    // The daemon can observe native work before its projection reaches this device.
    if (!hasActivity && result.status === 'busy' && result.diagnostics?.busySource === 'native_background_work') {
        if (!await confirmRunnerRestartStopsBackgroundWork(input)) return null;
        return await restart(true);
    }
    return result;
}

export async function restartSessionRunnerOnCurrentRuntime(
    input: RestartSessionRunnerInput,
): Promise<RestartSessionRunnerResultV1 | null> {
    input.signal?.throwIfAborted();
    const request = buildSessionRunnerRuntimeRefreshRequestV1(input.runtimeState);
    if ('ok' in request) return request;
    return await restartSessionRunnerWithBackgroundWorkConfirmation({ ...input,
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, request, reconcileMode: 'if_stale' });
}

export async function restartSessionRunnerForProviderBindingChange(
    input: RestartSessionRunnerForProviderBindingChangeInput,
): Promise<RestartSessionRunnerResultV1 | null> {
    const request = buildSessionRunnerProviderBindingRestartRequestV2(input);
    if ('ok' in request) return request;
    return await restartSessionRunnerWithBackgroundWorkConfirmation({
        runtimeState: input.runtimeState,
        serverId: input.serverId,
        signal: input.signal,
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
): Promise<FetchedSessionRunnerRuntimeStatus | RestartSessionRunnerResultV1> {
    try {
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(raw);
        if (!parsed.success) return projectSessionRunnerReadFailureV1(input.sessionId, raw);
        const state = readSessionRunnerRuntimeStateForRestartV1(parsed.data, input);
        return 'ok' in state ? state : { state, runnerProcessIdentity: null };
    } catch (error) {
        input.signal?.throwIfAborted();
        return projectSessionRunnerReadFailureV1(input.sessionId, error);
    }
}

export async function getSessionRunnerRuntimeStatusSnapshot(
    input: GetSessionRunnerRuntimeStatusInput,
): Promise<FetchedSessionRunnerRuntimeStatus | null> {
    const result = await getSessionRunnerRuntimeStatusSnapshotResult(input);
    return 'state' in result ? result : null;
}

/** Mutations retain the typed refusal; read-only status consumers retain their nullable projection. */
export async function getSessionRunnerRuntimeStatusSnapshotResult(
    input: GetSessionRunnerRuntimeStatusInput,
): Promise<FetchedSessionRunnerRuntimeStatus | RestartSessionRunnerResultV1> {
    const payload = SessionRunnerStatusGetRequestV1Schema.parse({
        sessionId: input.sessionId,
    } satisfies SessionRunnerStatusGetRequestV1);
    try {
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET,
            payload,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!isRpcMethodNotFoundResult(raw) && !isUnsupportedDaemonError(raw)) {
            const parsed = SessionRunnerRuntimeStatusV2Schema.safeParse(raw);
            if (parsed.success) {
                const state = readSessionRunnerRuntimeStateForRestartV1(parsed.data.state, input);
                if ('ok' in state) return state;
                return {
                    state,
                    runnerProcessIdentity: parsed.data.runnerProcessIdentity,
                };
            }
            if (raw && typeof raw === 'object' && 'errorCode' in raw) {
                return projectSessionRunnerReadFailureV1(input.sessionId, raw);
            }
        }
    } catch (error) {
        input.signal?.throwIfAborted();
        if (!isUnsupportedDaemonError(error)) return projectSessionRunnerReadFailureV1(input.sessionId, error);
        // Additive V2 may be absent on supported older daemons; V1 remains the status fallback.
    }
    return await getSessionRunnerRuntimeStatusV1Fallback(input, payload);
}
