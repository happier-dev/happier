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
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

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

export async function sessionExecutionRunStart(
    sessionId: string,
    request: ExecutionRunStartRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunStartResult> {
    try {
        const serverId = opts?.serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunStartResponse, ExecutionRunStartRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
            payload: request,
        });
        if (response && typeof response === 'object' && (response as any).ok === false && typeof (response as any).error === 'string') {
            return {
                ok: false,
                error: String((response as any).error),
                ...(typeof (response as any).errorCode === 'string' ? { errorCode: String((response as any).errorCode) } : {}),
            };
        }
        if (
            !response
            || typeof response !== 'object'
            || typeof (response as any).runId !== 'string'
            || typeof (response as any).callId !== 'string'
            || typeof (response as any).sidechainId !== 'string'
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

export async function sessionExecutionRunSend(
    sessionId: string,
    request: ExecutionRunSendRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunSendResult> {
    try {
        const serverId = opts?.serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunSendResponse, ExecutionRunSendRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
            payload: request,
        });
        if (!response || typeof response !== 'object' || (response as any).ok !== true) {
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

export async function sessionExecutionRunStop(
    sessionId: string,
    request: ExecutionRunStopRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunStopResult> {
    try {
        const serverId = opts?.serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunStopResponse, ExecutionRunStopRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            payload: request,
        });
        if (!response || typeof response !== 'object' || (response as any).ok !== true) {
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

export async function sessionExecutionRunList(
    sessionId: string,
    request: ExecutionRunListRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionExecutionRunListResult> {
    try {
        const serverId = opts?.serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunListResponse, ExecutionRunListRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            payload: request,
        });
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
        const serverId = opts?.serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunGetResponse, ExecutionRunGetRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            payload: request,
        });
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
        const serverId = opts?.serverId ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
        const response = await sessionRpcWithServerScope<ExecutionRunActionResponse, ExecutionRunActionRequest>({
            sessionId,
            serverId,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            payload: request,
        });
        if (!response || typeof response !== 'object' || typeof (response as any).ok !== 'boolean') {
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
