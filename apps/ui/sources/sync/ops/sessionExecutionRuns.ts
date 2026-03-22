import type {
    ExecutionRunActionRequest,
    ExecutionRunActionResponse,
    ExecutionRunGetRequest,
    ExecutionRunGetResponse,
    ExecutionRunListRequest,
    ExecutionRunListResponse,
    ExecutionRunSendRequest,
    ExecutionRunSendResponse,
    ExecutionRunStartRequest,
    ExecutionRunStartResponse,
    ExecutionRunStopRequest,
    ExecutionRunStopResponse,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { canUseSessionRpc } from '@/sync/ops/sessionMachineTarget';

export type SessionExecutionRunActionResult =
    | ExecutionRunActionResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunStartResult =
    | ExecutionRunStartResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunSendResult =
    | ExecutionRunSendResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunStopResult =
    | ExecutionRunStopResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunListResult =
    | ExecutionRunListResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunGetResult =
    | ExecutionRunGetResponse
    | { ok: false; error: string; errorCode?: string };

const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

function readErrorResponseShape(response: unknown): { ok: false; error: string; errorCode?: string } | null {
    if (!response || typeof response !== 'object') return null;
    if (typeof (response as any).error !== 'string') return null;
    return {
        ok: false,
        error: String((response as any).error),
        ...(typeof (response as any).errorCode === 'string' ? { errorCode: String((response as any).errorCode) } : {}),
    };
}

export function isExecutionRunNotRunningSendError(result: unknown): boolean {
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

function ensureExecutionRunMutationAllowed(sessionId: string): { ok: false; error: string; errorCode: string } | null {
    if (canUseSessionRpc(sessionId)) return null;
    return createInactiveSessionRpcUnavailableResult();
}

function notifyExecutionRunMutationSuccess(
    sessionId: string,
    response: ExecutionRunSendResponse | ExecutionRunStopResponse | ExecutionRunActionResponse,
): void {
    if (response && typeof response === 'object' && (response as any).ok === true) {
        notifyExecutionRunActivity(sessionId);
    }
}

export async function sessionExecutionRunStart(
    sessionId: string,
    request: ExecutionRunStartRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunStartResult> {
    try {
        const inactiveSessionResult = ensureExecutionRunMutationAllowed(sessionId);
        if (inactiveSessionResult) return inactiveSessionResult;
        const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
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
        notifyExecutionRunActivity(sessionId);
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunSend(
    sessionId: string,
    request: ExecutionRunSendRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunSendResult> {
    try {
        const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
        const payload: ExecutionRunSendRequest =
            request.delivery === undefined
                ? { ...request, delivery: 'steer_if_supported' }
                : request;
        const response = await sessionRpcWithServerScope<ExecutionRunSendResponse, ExecutionRunSendRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
            payload,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as any).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, response);
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
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunStopResult> {
    try {
        const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunStopResponse, ExecutionRunStopRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as any).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, response);
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
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunListResult> {
    try {
        const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunListResponse, ExecutionRunListRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (
            !response
            || typeof response !== 'object'
            || !Array.isArray((response as any).runs)
        ) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return response;
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
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunGetResult> {
    try {
        const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunGetResponse, ExecutionRunGetRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (
            !response
            || typeof response !== 'object'
            || !(response as any).run
            || typeof (response as any).run?.runId !== 'string'
        ) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return response;
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
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunActionResult> {
    try {
        const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunActionResponse, ExecutionRunActionRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            payload: request,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || typeof (response as any).ok !== 'boolean') {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, response);
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
