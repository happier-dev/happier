import {
    RestartSessionRunnerRequestV1Schema,
    RestartSessionRunnerResultV1Schema,
    SessionRunnerRuntimeStateV1Schema,
    SessionRunnerStatusGetRequestV1Schema,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
    type RestartSessionRunnerRequestV1,
    type RestartSessionRunnerStatusV1,
    type SessionRunnerRuntimeStateV1,
    type SessionRunnerStatusGetRequestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type RestartStaleSessionRunnerRequest = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
    expectedRunnerPid: number;
    expectedProcessCommandHash: string;
    expectedRunnerEntrypointIdentity: string;
}>;

export type RestartSessionRunnerForConfigurationRequest = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
    expectedRunnerPid: number;
}>;

export type GetSessionRunnerRuntimeStatusRequest = Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
}>;

type RestartStaleSessionRunnerSuccessStatus = Extract<
    RestartSessionRunnerStatusV1,
    'restarted' | 'already_current'
>;

type RestartStaleSessionRunnerSkipStatus = Extract<
    RestartSessionRunnerStatusV1,
    'runner_identity_changed' | 'busy' | 'ineligible' | 'version_unknown' | 'unsupported_daemon'
>;

export type RestartStaleSessionRunnerStatus =
    | RestartStaleSessionRunnerSuccessStatus
    | RestartStaleSessionRunnerSkipStatus
    | 'refresh_unsupported'
    | 'failure';

export type RestartStaleSessionRunnerResult =
    | Readonly<{ ok: true; status: RestartStaleSessionRunnerSuccessStatus; sessionId: string }>
    | Readonly<{ ok: false; status: Exclude<RestartStaleSessionRunnerStatus, RestartStaleSessionRunnerSuccessStatus>; sessionId: string; error?: string }>;

const SUCCESS_STATUSES = new Set<RestartSessionRunnerStatusV1>([
    'restarted',
    'already_current',
]);

const INELIGIBLE_STATUSES = new Set<RestartSessionRunnerStatusV1>([
    'not_found',
    'not_tracked',
    'not_daemon_started',
    'runner_not_active',
    'missing_resume_snapshot',
    'missing_spawn_options',
    'ineligible',
]);

// Compatibility-stable released wire value. It now identifies the shared UI
// composer restart-banner entry point, not only the stale-version presentation.
const UI_COMPOSER_RESTART_BANNER_WIRE_REASON = 'ui_stale_runner_banner' as const;

export function normalizeRestartSessionRunnerResult(
    value: unknown,
    fallbackSessionId: string,
): RestartStaleSessionRunnerResult {
    const parsedResult = RestartSessionRunnerResultV1Schema.safeParse(value);
    if (!parsedResult.success) {
        return {
            ok: false,
            status: 'failure',
            sessionId: fallbackSessionId,
            error: 'malformed_session_runner_restart_result',
        };
    }

    const result = parsedResult.data;
    if (SUCCESS_STATUSES.has(result.status) && result.ok === true) {
        return { ok: true, status: result.status as RestartStaleSessionRunnerSuccessStatus, sessionId: result.sessionId };
    }

    if (result.ok === false) {
        if (result.status === 'runner_identity_changed') {
            return { ok: false, status: 'runner_identity_changed', sessionId: result.sessionId };
        }
        if (result.status === 'busy') {
            return { ok: false, status: 'busy', sessionId: result.sessionId };
        }
        if (result.status === 'version_unknown') {
            return { ok: false, status: 'version_unknown', sessionId: result.sessionId };
        }
        if (result.status === 'unsupported_daemon') {
            return { ok: false, status: 'unsupported_daemon', sessionId: result.sessionId };
        }
        if (
            result.status === 'ineligible'
            && result.reasonCode === 'non_destructive_refresh_unsupported'
        ) {
            return { ok: false, status: 'refresh_unsupported', sessionId: result.sessionId };
        }
        if (INELIGIBLE_STATUSES.has(result.status)) {
            return { ok: false, status: 'ineligible', sessionId: result.sessionId };
        }
        if (
            result.status === 'stop_failed'
            || result.status === 'spawn_failed'
            || result.status === 'partial_failure'
        ) {
            return { ok: false, status: 'failure', sessionId: result.sessionId };
        }
    }

    return {
        ok: false,
        status: 'failure',
        sessionId: parsedResult.data.sessionId || fallbackSessionId,
        error: 'malformed_session_runner_restart_result',
    };
}

async function requestSessionRunnerRestart(
    request: Readonly<{ sessionId: string; machineId: string; serverId?: string | null }>,
    restart: Omit<RestartSessionRunnerRequestV1, 'sessionId' | 'reason'>,
): Promise<RestartStaleSessionRunnerResult> {
    try {
        const payload = RestartSessionRunnerRequestV1Schema.parse({
            sessionId: request.sessionId,
            ...restart,
            reason: UI_COMPOSER_RESTART_BANNER_WIRE_REASON,
        } satisfies RestartSessionRunnerRequestV1);
        const result = await machineRpcWithServerScope<unknown, RestartSessionRunnerRequestV1>({
            machineId: request.machineId,
            serverId: request.serverId ?? null,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            payload,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: request.sessionId,
            },
        });
        return normalizeRestartSessionRunnerResult(result, request.sessionId);
    } catch (error) {
        const errorCode = readRpcErrorCode(error);
        return {
            ok: false,
            status: isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)
                ? 'unsupported_daemon'
                : 'failure',
            sessionId: request.sessionId,
            error: errorCode ?? (error instanceof Error ? error.message : 'session_runner_restart_failed'),
        };
    }
}

export function restartStaleSessionRunner(
    request: RestartStaleSessionRunnerRequest,
): Promise<RestartStaleSessionRunnerResult> {
    return requestSessionRunnerRestart(request, {
        mode: 'if_stale',
        expectedRunnerPid: request.expectedRunnerPid,
        expectedProcessCommandHash: request.expectedProcessCommandHash,
        expectedRunnerEntrypointIdentity: request.expectedRunnerEntrypointIdentity,
    });
}

export function restartSessionRunnerForConfiguration(
    request: RestartSessionRunnerForConfigurationRequest,
): Promise<RestartStaleSessionRunnerResult> {
    return requestSessionRunnerRestart(request, {
        mode: 'force_current_cli',
        expectedRunnerPid: request.expectedRunnerPid,
    });
}

/**
 * Restart operations are accepted-then-observed: the daemon signals the tracked runner to exit and
 * respawns it on the current CLI asynchronously. A single "restarted" ack rides a control-plane
 * request that can be torn down (transport timeout / severed socket) before the respawn completes,
 * so a succeeding restart can surface to the caller as a generic `failure`. `didSessionRunnerRestartLand`
 * lets the caller confirm the outcome from the daemon-owned runtime status instead of trusting the
 * possibly-lost ack: the targeted stale runner is gone once the runtime is re-attested `current` or a
 * new live process has replaced the PID we asked to restart.
 */
export function didSessionRunnerRestartLand(input: Readonly<{
    state: SessionRunnerRuntimeStateV1 | null;
    expectedRunnerPid: number;
}>): boolean {
    const state = input.state;
    if (!state) return false;
    if (state.versionState === 'current') return true;
    const pid = state.runner.pid;
    const expectedRunnerPid = input.expectedRunnerPid;
    return (
        typeof pid === 'number'
        && pid > 0
        && Number.isInteger(expectedRunnerPid)
        && expectedRunnerPid > 0
        && pid !== expectedRunnerPid
    );
}

/** A forced restart is landed only when the exact targeted process was replaced. */
export function didForcedSessionRunnerRestartLand(input: Readonly<{
    state: SessionRunnerRuntimeStateV1 | null;
    expectedRunnerPid: number;
}>): boolean {
    const pid = input.state?.runner.pid;
    return (
        typeof pid === 'number'
        && pid > 0
        && Number.isInteger(input.expectedRunnerPid)
        && input.expectedRunnerPid > 0
        && pid !== input.expectedRunnerPid
    );
}

export type RestartStaleSessionRunnerWithObserveDeps = Readonly<{
    restart?: (request: RestartStaleSessionRunnerRequest) => Promise<RestartStaleSessionRunnerResult>;
    getStatus?: (request: GetSessionRunnerRuntimeStatusRequest) => Promise<SessionRunnerRuntimeStateV1 | null>;
    sleep?: (ms: number) => Promise<void>;
    observeAttempts?: number;
    observeIntervalMs?: number;
}>;

const DEFAULT_RESTART_OBSERVE_ATTEMPTS = 8;
const DEFAULT_RESTART_OBSERVE_INTERVAL_MS = 1_500;

async function restartSessionRunnerWithObserve<Request extends Readonly<{
    sessionId: string;
    machineId: string;
    serverId?: string | null;
    expectedRunnerPid: number;
}>>(input: Readonly<{
    request: Request;
    restart: (request: Request) => Promise<RestartStaleSessionRunnerResult>;
    getStatus: (request: GetSessionRunnerRuntimeStatusRequest) => Promise<SessionRunnerRuntimeStateV1 | null>;
    didLand: (input: Readonly<{ state: SessionRunnerRuntimeStateV1 | null; expectedRunnerPid: number }>) => boolean;
    sleep: (ms: number) => Promise<void>;
    observeAttempts?: number;
    observeIntervalMs?: number;
}>): Promise<RestartStaleSessionRunnerResult> {
    const attempts = Math.max(1, Math.trunc(input.observeAttempts ?? DEFAULT_RESTART_OBSERVE_ATTEMPTS));
    const intervalMs = Math.max(0, Math.trunc(input.observeIntervalMs ?? DEFAULT_RESTART_OBSERVE_INTERVAL_MS));
    const result = await input.restart(input.request);
    if (result.ok || result.status !== 'failure') return result;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const state = await input.getStatus({
            sessionId: input.request.sessionId,
            machineId: input.request.machineId,
            serverId: input.request.serverId ?? null,
        });
        if (input.didLand({ state, expectedRunnerPid: input.request.expectedRunnerPid })) {
            return { ok: true, status: 'restarted', sessionId: input.request.sessionId };
        }
        if (attempt < attempts - 1 && intervalMs > 0) await input.sleep(intervalMs);
    }
    return result;
}

/**
 * Restart the stale runner, then — only when the ack came back as an ambiguous `failure`
 * (transport timeout / severed ack channel / spawn ambiguity) — observe the daemon-owned runtime
 * status to see whether the restart actually landed. Definitive negatives (busy, ineligible,
 * runner_identity_changed, version_unknown, unsupported_daemon) mean the runner was NOT restarted and
 * are surfaced unchanged, so their dedicated UX is preserved. This prevents the false-negative where a
 * succeeding restart tears down its own ack channel and the caller reports failure on a working op.
 */
export async function restartStaleSessionRunnerWithObserve(
    request: RestartStaleSessionRunnerRequest,
    deps: RestartStaleSessionRunnerWithObserveDeps = {},
): Promise<RestartStaleSessionRunnerResult> {
    const restart = deps.restart ?? restartStaleSessionRunner;
    const getStatus = deps.getStatus ?? getSessionRunnerRuntimeStatus;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    return restartSessionRunnerWithObserve({
        request,
        restart,
        getStatus,
        didLand: didSessionRunnerRestartLand,
        sleep,
        observeAttempts: deps.observeAttempts,
        observeIntervalMs: deps.observeIntervalMs,
    });
}

export type RestartSessionRunnerForConfigurationWithObserveDeps = Readonly<{
    restart?: (request: RestartSessionRunnerForConfigurationRequest) => Promise<RestartStaleSessionRunnerResult>;
    getStatus?: (request: GetSessionRunnerRuntimeStatusRequest) => Promise<SessionRunnerRuntimeStateV1 | null>;
    sleep?: (ms: number) => Promise<void>;
    observeAttempts?: number;
    observeIntervalMs?: number;
}>;

export async function restartSessionRunnerForConfigurationWithObserve(
    request: RestartSessionRunnerForConfigurationRequest,
    deps: RestartSessionRunnerForConfigurationWithObserveDeps = {},
): Promise<RestartStaleSessionRunnerResult> {
    const restart = deps.restart ?? restartSessionRunnerForConfiguration;
    const getStatus = deps.getStatus ?? getSessionRunnerRuntimeStatus;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    return restartSessionRunnerWithObserve({
        request,
        restart,
        getStatus,
        didLand: didForcedSessionRunnerRestartLand,
        sleep,
        observeAttempts: deps.observeAttempts,
        observeIntervalMs: deps.observeIntervalMs,
    });
}

export async function getSessionRunnerRuntimeStatus(
    request: GetSessionRunnerRuntimeStatusRequest,
): Promise<SessionRunnerRuntimeStateV1 | null> {
    try {
        const payload = SessionRunnerStatusGetRequestV1Schema.parse({
            sessionId: request.sessionId,
        } satisfies SessionRunnerStatusGetRequestV1);
        const result = await machineRpcWithServerScope<unknown, SessionRunnerStatusGetRequestV1>({
            machineId: request.machineId,
            serverId: request.serverId ?? null,
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload,
        });
        const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(result);
        if (!parsed.success || parsed.data.sessionId !== payload.sessionId) return null;
        return parsed.data;
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return null;
        return null;
    }
}
