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
import { canUseSessionRpc, readMachineTargetForSession, resolveMachinePathFromSessionBase, shouldFallbackToSessionRpc } from './sessionMachineTarget';

const SCM_UNSUPPORTED_RESPONSE_ERROR = 'SCM_UNSUPPORTED_RESPONSE_ERROR';
const SCM_DIFF_COMMIT_TIMEOUT_MS = 120_000;

function resolveScmRpcTimeoutMs(method: string): number | undefined {
    if (method === RPC_METHODS.SCM_DIFF_COMMIT) return SCM_DIFF_COMMIT_TIMEOUT_MS;
    return undefined;
}

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

async function callScmPreferMachine<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends { cwd?: string; backendPreference?: unknown }
>(
    sessionId: string,
    method: string,
    request: R,
): Promise<T> {
    const machineTarget = readMachineTargetForSession(sessionId);

    if (machineTarget) {
        const cwd = resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: request.cwd });
        const machineRequest = withScmBackendPreference({ ...request, cwd } as R);
        const timeoutMs = resolveScmRpcTimeoutMs(method);
        try {
            const response = timeoutMs
                ? await apiSocket.machineRPC<T, R>(
                    machineTarget.machineId,
                    method,
                    machineRequest as R,
                    { timeoutMs },
                )
                : await apiSocket.machineRPC<T, R>(
                    machineTarget.machineId,
                    method,
                    machineRequest as R,
                );
            return assertScmResponse<T>(response);
        } catch (error) {
            if (!shouldFallbackToSessionRpc(sessionId, error)) {
                return scmFallbackError<T>(error);
            }
        }
    }

    if (!canUseSessionRpc(sessionId)) {
        return {
            success: false,
            error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        } as T;
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
