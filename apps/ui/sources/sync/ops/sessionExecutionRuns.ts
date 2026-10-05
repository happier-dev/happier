import type {
    ExecutionRunActionRequest,
    ExecutionRunActionResponse,
    ExecutionRunCancelTurnRequest,
    ExecutionRunCancelTurnResponse,
    ExecutionRunEnsureResponse,
    ExecutionRunGetRequest,
    ExecutionRunGetResponse,
    ExecutionRunListRequest,
    ExecutionRunListResponse,
    ExecutionRunStartRequest,
    ExecutionRunStartResponse,
    ExecutionRunStopRequest,
    ExecutionRunStopResponse,
} from '@happier-dev/protocol';
import {
    ExecutionRunGetResponseSchema,
    ExecutionRunListResponseSchema,
    withExecutionRunStartFailureDetails,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { sessionRpcWithServerAccountScope, sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    canUseSessionRpc,
    readMachineControlTargetForSession,
} from '@/sync/ops/sessionMachineTarget';
import { storage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    canSendUserMessageToSession,
    SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
} from '@/sync/domains/session/input/sessionMessageSendEligibility';

export type SessionExecutionRunActionResult =
    | ExecutionRunActionResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunStartResult =
    | ExecutionRunStartResponse
    | { ok: false; error: string; errorCode?: string; details?: unknown };

export type SessionExecutionRunStopResult =
    | ExecutionRunStopResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunCancelTurnResult =
    | ExecutionRunCancelTurnResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunResumeResult =
    | ExecutionRunEnsureResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunListResult =
    | ExecutionRunListResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunGetResult =
    | ExecutionRunGetResponse
    | { ok: false; error: string; errorCode?: string };

function executionRunSessionRpc<R, A>(params: Readonly<{
    sessionId: string;
    serverId: string;
    scope?: ServerAccountScope;
    method: string;
    payload: A;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>): Promise<R> {
    return params.scope
        ? sessionRpcWithServerAccountScope<R, A>({ ...params, scope: params.scope })
        : sessionRpcWithServerScope<R, A>(params);
}

function readErrorResponseShape(response: unknown): { ok: false; error: string; errorCode?: string; details?: unknown } | null {
    if (!response || typeof response !== 'object') return null;
    if (typeof (response as any).error !== 'string') return null;
    return {
        ok: false,
        error: String((response as any).error),
        ...(typeof (response as any).errorCode === 'string' ? { errorCode: String((response as any).errorCode) } : {}),
        ...('details' in response ? { details: (response as { details?: unknown }).details } : {}),
    };
}

export function isExecutionRunNotRunningMutationError(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    if ((result as any).ok !== false) return false;

    const errorCode = typeof (result as any).errorCode === 'string' ? String((result as any).errorCode).trim().toLowerCase() : '';
    if (errorCode === 'execution_run_not_allowed' || errorCode === 'execution_run_not_running') return true;

    const error = typeof (result as any).error === 'string' ? String((result as any).error).trim().toLowerCase() : '';
    return error.includes('not running') || error.includes('already finished');
}

function createInactiveSessionRpcUnavailableResult(): { ok: false; error: string; errorCode: string } {
    return {
        ok: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };
}

function resolveExecutionRunSessionServerId(
    sessionId: string,
    requestedServerId?: string | null,
): string | null {
    const explicitServerId = typeof requestedServerId === 'string' ? requestedServerId.trim() : '';
    const session = storage.getState().sessions[sessionId] ?? null;
    const storedServerId = typeof session?.serverId === 'string' ? session.serverId.trim() : '';
    if (explicitServerId) {
        if (storedServerId && !areServerProfileIdentifiersEquivalent(storedServerId, explicitServerId)) {
            return null;
        }
        return explicitServerId;
    }
    return storedServerId || null;
}

function createExecutionRunHomeUnavailableResult(): { ok: false; error: string; errorCode: string } {
    return {
        ok: false,
        error: 'Execution Run Home is unavailable',
        errorCode: 'execution_run_home_unavailable',
    };
}

function ensureExecutionRunMutationAllowed(sessionId: string): { ok: false; error: string; errorCode: string } | null {
    if (canUseSessionRpc(sessionId)) return null;
    return createInactiveSessionRpcUnavailableResult();
}

function createSessionMessageNotResumableResult(): { ok: false; error: string; errorCode: string } {
    return {
        ok: false,
        error: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
        errorCode: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
    };
}

function ensureExecutionRunUserMessageAllowed(sessionId: string): { ok: false; error: string; errorCode: string } | null {
    const state = storage.getState();
    const session = state.sessions[sessionId] ?? null;
    if (!session) return null;
    return canSendUserMessageToSession(session, {
        resumeCapabilityOptions: { accountSettings: state.settings },
    }) ? null : createSessionMessageNotResumableResult();
}

function notifyExecutionRunMutationSuccess(
    sessionId: string,
    serverId: string,
    response: ExecutionRunStopResponse | ExecutionRunActionResponse,
): void {
    if (response && typeof response === 'object' && (response as any).ok === true) {
        notifyExecutionRunActivity({ serverId, sessionId });
    }
}

export async function sessionExecutionRunStart(
    sessionId: string,
    request: ExecutionRunStartRequest,
    opts?: Readonly<{ serverId?: string | null; expectedMachineId?: string | null }>,
): Promise<SessionExecutionRunStartResult> {
    try {
        const serverId = resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const expectedMachineId = opts?.expectedMachineId?.trim() || null;
        if (expectedMachineId) {
            const currentTarget = readMachineControlTargetForSession({ serverId, sessionId });
            if (currentTarget?.machineId !== expectedMachineId) {
                return {
                    ok: false,
                    error: 'execution_run_target_changed',
                    errorCode: 'execution_run_target_changed',
                    details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
                };
            }
        }
        const inactiveSessionResult = ensureExecutionRunMutationAllowed(sessionId);
        if (inactiveSessionResult) return inactiveSessionResult;
        const response = await sessionRpcWithServerScope<ExecutionRunStartResponse, ExecutionRunStartRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (
            !response
            || typeof response !== 'object'
            || typeof (response as any).runId !== 'string'
            || typeof (response as any).callId !== 'string'
            || typeof (response as any).sidechainId !== 'string'
        ) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunActivity({ serverId, sessionId });
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunStop(
    sessionId: string,
    request: ExecutionRunStopRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope }>,
): Promise<SessionExecutionRunStopResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await executionRunSessionRpc<ExecutionRunStopResponse, ExecutionRunStopRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as any).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, serverId, response);
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunCancelTurn(
    sessionId: string,
    request: ExecutionRunCancelTurnRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunCancelTurnResult> {
    try {
        const serverId = resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await sessionRpcWithServerScope<ExecutionRunCancelTurnResponse, ExecutionRunCancelTurnRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunActivity({ serverId, sessionId });
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

/** Explicit UI resume over the canonical Run ensure/resume owner. */
export async function sessionExecutionRunResume(
    sessionId: string,
    request: Readonly<{ runId: string }>,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunResumeResult> {
    try {
        const serverId = resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await sessionRpcWithServerScope<ExecutionRunEnsureResponse, Readonly<{ runId: string; resume: true }>>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
            payload: { runId: request.runId, resume: true },
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunActivity({ serverId, sessionId });
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunList(
    sessionId: string,
    request: ExecutionRunListRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope }>,
): Promise<SessionExecutionRunListResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await executionRunSessionRpc<unknown, ExecutionRunListRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        const parsed = ExecutionRunListResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return parsed.data;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunGet(
    sessionId: string,
    request: ExecutionRunGetRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
): Promise<SessionExecutionRunGetResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await executionRunSessionRpc<unknown, ExecutionRunGetRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            payload: request,
            ...(request.waitForInputId || request.waitForOutput ? { timeoutMs: null } : {}),
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        const parsed = ExecutionRunGetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return parsed.data;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunWait(
    sessionId: string,
    request: unknown,
    opts?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<unknown> {
    try {
        const serverId = resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        return await sessionRpcWithServerScope<unknown, unknown>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
            payload: request,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunAction(
    sessionId: string,
    request: ExecutionRunActionRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope }>,
): Promise<SessionExecutionRunActionResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const sessionMessageResult = ensureExecutionRunUserMessageAllowed(sessionId);
        if (sessionMessageResult) return sessionMessageResult;
        const response = await executionRunSessionRpc<ExecutionRunActionResponse, ExecutionRunActionRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || typeof (response as any).ok !== 'boolean') {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, serverId, response);
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
