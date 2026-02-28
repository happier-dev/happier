import type {
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
    ScmChangeDiscardRequest,
    ScmChangeDiscardResponse,
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmDiffFileRequest,
    ScmDiffFileResponse,
    ScmLogListRequest,
    ScmLogListResponse,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '../domains/state/storage';
import { apiSocket } from '../api/session/apiSocket';

const SCM_UNSUPPORTED_RESPONSE_ERROR = 'SCM_UNSUPPORTED_RESPONSE_ERROR';

function scmFallbackError<T extends { success: boolean; error?: string; errorCode?: string }>(error: unknown): T {
    if (error instanceof Error && error.message === SCM_UNSUPPORTED_RESPONSE_ERROR) {
        return {
            success: false,
            error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        } as T;
    }
    if (error && typeof error === 'object') {
        const rpcError: RpcErrorCarrier = {
            rpcErrorCode:
                typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'string'
                    ? (error as { rpcErrorCode: string }).rpcErrorCode
                    : undefined,
            message:
                typeof (error as { message?: unknown }).message === 'string'
                    ? (error as { message: string }).message
                    : undefined,
        };

        if (isRpcMethodNotAvailableError(rpcError)) {
            return {
                success: false,
                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            } as T;
        }
        if (isRpcMethodNotFoundError(rpcError)) {
            return {
                success: false,
                error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            } as T;
        }
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
        success: false,
        error: message,
        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    } as T;
}

function assertScmResponse<T extends { success: boolean; error?: string; errorCode?: string }>(value: unknown): T {
    if (
        !value
        || typeof value !== 'object'
        || typeof (value as { success?: unknown }).success !== 'boolean'
    ) {
        throw new Error(SCM_UNSUPPORTED_RESPONSE_ERROR);
    }
    return value as T;
}

function withScmBackendPreference<T extends { backendPreference?: unknown }>(request: T): T {
    const preferredBackend = storage.getState().settings.scmGitRepoPreferredBackend;
    if (preferredBackend === 'sapling') {
        return {
            ...request,
            backendPreference: {
                kind: 'prefer',
                backendId: 'sapling',
            },
        };
    }
    return request;
}

function resolveMachineScmCwd(input: { baseCwd: string; requestCwd?: string }): string {
    const requestCwd = input.requestCwd;
    if (!requestCwd || requestCwd === '.') {
        return input.baseCwd;
    }
    if (requestCwd.startsWith('~')) {
        return requestCwd;
    }
    const isAbsolutePosix = requestCwd.startsWith('/');
    const isAbsoluteWindows = /^[a-zA-Z]:[\\/]/.test(requestCwd) || requestCwd.startsWith('\\\\');
    if (isAbsolutePosix || isAbsoluteWindows) {
        return requestCwd;
    }
    const separator = input.baseCwd.includes('\\') ? '\\' : '/';
    const base = input.baseCwd.endsWith(separator) ? input.baseCwd.slice(0, -1) : input.baseCwd;
    const rel = requestCwd.startsWith(separator) ? requestCwd.slice(1) : requestCwd;
    return `${base}${separator}${rel}`;
}

function readScmMachineTarget(sessionId: string): { machineId: string; baseCwd: string } | null {
    const state = storage.getState();
    const session = state.sessions?.[sessionId];
    const machineId = session?.metadata?.machineId;
    const baseCwd = session?.metadata?.path;
    if (typeof machineId !== 'string' || machineId.trim().length === 0) return null;
    if (typeof baseCwd !== 'string' || baseCwd.trim().length === 0) return null;
    return { machineId, baseCwd };
}

function shouldFallbackFromMachineRpc(error: unknown): boolean {
    if (error instanceof Error && typeof error.message === 'string') {
        if (error.message.includes('Machine encryption not found')) return true;
        if (error.message.includes('Socket not connected')) return true;
    }

    if (error && typeof error === 'object') {
        const rpcError: RpcErrorCarrier = {
            rpcErrorCode:
                typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'string'
                    ? (error as { rpcErrorCode: string }).rpcErrorCode
                    : undefined,
            message:
                typeof (error as { message?: unknown }).message === 'string'
                    ? (error as { message: string }).message
                    : undefined,
        };
        return isRpcMethodNotAvailableError(rpcError) || isRpcMethodNotFoundError(rpcError);
    }

    return false;
}

async function callScmPreferMachine<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends { cwd?: string; backendPreference?: unknown }
>(
    sessionId: string,
    method: string,
    request: R,
): Promise<T> {
    const machineTarget = readScmMachineTarget(sessionId);

    if (machineTarget) {
        const cwd = resolveMachineScmCwd({ baseCwd: machineTarget.baseCwd, requestCwd: request.cwd });
        const machineRequest = withScmBackendPreference({ ...request, cwd });
        try {
            const response = await apiSocket.machineRPC<T, R>(machineTarget.machineId, method, machineRequest);
            return assertScmResponse<T>(response);
        } catch (error) {
            if (!shouldFallbackFromMachineRpc(error)) {
                return scmFallbackError<T>(error);
            }
        }
    }

    try {
        const response = await apiSocket.sessionRPC<T, R>(sessionId, method, withScmBackendPreference(request));
        return assertScmResponse<T>(response);
    } catch (error) {
        return scmFallbackError<T>(error);
    }
}

export async function sessionScmStatusSnapshot(
    sessionId: string,
    request: ScmStatusSnapshotRequest
): Promise<ScmStatusSnapshotResponse> {
    return await callScmPreferMachine<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
        sessionId,
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        request
    );
}

export async function sessionScmDiffFile(
    sessionId: string,
    request: ScmDiffFileRequest
): Promise<ScmDiffFileResponse> {
    return await callScmPreferMachine<ScmDiffFileResponse, ScmDiffFileRequest>(
        sessionId,
        RPC_METHODS.SCM_DIFF_FILE,
        request
    );
}

export async function sessionScmDiffCommit(
    sessionId: string,
    request: ScmDiffCommitRequest
): Promise<ScmDiffCommitResponse> {
    return await callScmPreferMachine<ScmDiffCommitResponse, ScmDiffCommitRequest>(
        sessionId,
        RPC_METHODS.SCM_DIFF_COMMIT,
        request
    );
}

export async function sessionScmChangeInclude(
    sessionId: string,
    request: ScmChangeApplyRequest
): Promise<ScmChangeApplyResponse> {
    return await callScmPreferMachine<ScmChangeApplyResponse, ScmChangeApplyRequest>(
        sessionId,
        RPC_METHODS.SCM_CHANGE_INCLUDE,
        request
    );
}

export async function sessionScmChangeExclude(
    sessionId: string,
    request: ScmChangeApplyRequest
): Promise<ScmChangeApplyResponse> {
    return await callScmPreferMachine<ScmChangeApplyResponse, ScmChangeApplyRequest>(
        sessionId,
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        request
    );
}

export async function sessionScmChangeDiscard(
    sessionId: string,
    request: ScmChangeDiscardRequest
): Promise<ScmChangeDiscardResponse> {
    return await callScmPreferMachine<ScmChangeDiscardResponse, ScmChangeDiscardRequest>(
        sessionId,
        RPC_METHODS.SCM_CHANGE_DISCARD,
        request
    );
}

export async function sessionScmCommitCreate(
    sessionId: string,
    request: ScmCommitCreateRequest
): Promise<ScmCommitCreateResponse> {
    return await callScmPreferMachine<ScmCommitCreateResponse, ScmCommitCreateRequest>(
        sessionId,
        RPC_METHODS.SCM_COMMIT_CREATE,
        request
    );
}

export async function sessionScmLogList(
    sessionId: string,
    request: ScmLogListRequest
): Promise<ScmLogListResponse> {
    return await callScmPreferMachine<ScmLogListResponse, ScmLogListRequest>(
        sessionId,
        RPC_METHODS.SCM_LOG_LIST,
        request
    );
}

export async function sessionScmCommitBackout(
    sessionId: string,
    request: ScmCommitBackoutRequest
): Promise<ScmCommitBackoutResponse> {
    return await callScmPreferMachine<ScmCommitBackoutResponse, ScmCommitBackoutRequest>(
        sessionId,
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        request
    );
}

export async function sessionScmRemoteFetch(
    sessionId: string,
    request: ScmRemoteRequest
): Promise<ScmRemoteResponse> {
    return await callScmPreferMachine<ScmRemoteResponse, ScmRemoteRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_FETCH,
        request
    );
}

export async function sessionScmRemotePush(
    sessionId: string,
    request: ScmRemoteRequest
): Promise<ScmRemoteResponse> {
    return await callScmPreferMachine<ScmRemoteResponse, ScmRemoteRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_PUSH,
        request
    );
}

export async function sessionScmRemotePull(
    sessionId: string,
    request: ScmRemoteRequest
): Promise<ScmRemoteResponse> {
    return await callScmPreferMachine<ScmRemoteResponse, ScmRemoteRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_PULL,
        request
    );
}
