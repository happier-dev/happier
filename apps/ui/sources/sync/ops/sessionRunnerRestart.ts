import { buildSessionRunnerRuntimeRefreshRequestV1, projectSessionRunnerReadFailureV1, readSessionRunnerRestartIdentityGuardV1, RestartSessionRunnerResultV1Schema, type RestartSessionRunnerResultV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { RestartSessionRunnerRequestV2Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV2';
import { SessionProviderBindingSecurityChangeConfirmationV1Schema, type SessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { readSessionRunnerRuntimeStateForRestartV1, SessionRunnerRuntimeStateV1Schema, SessionRunnerStatusGetRequestV1Schema, type SessionRunnerRuntimeStateV1, type SessionRunnerStatusGetRequestV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { SessionRunnerRuntimeStatusV2Schema, type SessionRunnerProcessIdentityV2 } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV2';
import {
    isRpcMethodNotFoundResult,
    RPC_ERROR_CODES,
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

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
    launchBinding?: SessionProviderBindingMetadataV1 | null;
    nextBindingSecurityFingerprint?: string | null;
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
        if (isUnsupportedDaemonError(raw) || (input.fallbackMethod && readRpcErrorCode(raw) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE)
            || (!input.fallbackMethod && isRpcMethodNotFoundResult(raw))) {
            return await unsupported();
        }

        const parsed = RestartSessionRunnerResultV1Schema.safeParse(raw);
        result = parsed.success && parsed.data.sessionId === input.runtimeState.sessionId
            ? parsed.data : projectSessionRunnerReadFailureV1(input.runtimeState.sessionId, raw);
    } catch (error) {
        input.signal?.throwIfAborted();
        if (isUnsupportedDaemonError(error) || (input.fallbackMethod && readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE)) {
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
    const identityGuard = readSessionRunnerRestartIdentityGuardV1(input.runtimeState);
    if ('ok' in identityGuard) return identityGuard;
    if (!input.runnerProcessIdentity) {
        return buildResult({ sessionId: input.runtimeState.sessionId, status: 'version_unknown', reasonCode: 'runner_generation_unattested' });
    }
    // Never combine a runtime guard with another process's birth witness.
    if (identityGuard.expectedRunnerPid !== input.runnerProcessIdentity.pid) {
        return buildResult({ sessionId: input.runtimeState.sessionId, status: 'runner_identity_changed' });
    }
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
