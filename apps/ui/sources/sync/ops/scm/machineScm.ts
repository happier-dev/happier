import type {
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchListRequest,
    ScmBranchListResponse,
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
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmStashApplyRequest,
    ScmStashApplyResponse,
    ScmStashDropRequest,
    ScmStashDropResponse,
    ScmStashListRequest,
    ScmStashListResponse,
    ScmStashPopRequest,
    ScmStashPopResponse,
    ScmStashShowRequest,
    ScmStashShowResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '@/sync/domains/state/storage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

const SCM_UNSUPPORTED_RESPONSE_ERROR = 'SCM_UNSUPPORTED_RESPONSE_ERROR';
const SCM_DIFF_COMMIT_TIMEOUT_MS = 120_000;

function resolveScmRpcTimeoutMs(method: string): number | undefined {
    if (method === RPC_METHODS.SCM_DIFF_COMMIT) {
        return SCM_DIFF_COMMIT_TIMEOUT_MS;
    }
    return undefined;
}

export function scmFallbackError<T extends { success: boolean; error?: string; errorCode?: string }>(error: unknown): T {
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

export function assertScmResponse<T extends { success: boolean; error?: string; errorCode?: string }>(value: unknown): T {
    if (
        !value
        || typeof value !== 'object'
        || typeof (value as { success?: unknown }).success !== 'boolean'
    ) {
        throw new Error(SCM_UNSUPPORTED_RESPONSE_ERROR);
    }
    return value as T;
}

export function withScmBackendPreference<T extends { backendPreference?: unknown }>(request: T): T {
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

export async function runMachineScmRpc<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends { cwd?: string; backendPreference?: unknown }
>(
    machineId: string,
    method: string,
    request: R,
): Promise<T> {
    const payload = withScmBackendPreference(request);
    const timeoutMs = resolveScmRpcTimeoutMs(method);
    const response = await machineRpcWithServerScope<T, R>({
        machineId,
        method,
        payload: payload as R,
        timeoutMs,
    });
    return assertScmResponse<T>(response);
}

async function callMachineScm<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends { cwd?: string; backendPreference?: unknown }
>(
    machineId: string,
    method: string,
    request: R,
): Promise<T> {
    try {
        return await runMachineScmRpc<T, R>(machineId, method, request);
    } catch (error) {
        return scmFallbackError<T>(error);
    }
}

export async function machineScmStatusSnapshot(
    machineId: string,
    request: ScmStatusSnapshotRequest,
): Promise<ScmStatusSnapshotResponse> {
    return await callMachineScm<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(machineId, RPC_METHODS.SCM_STATUS_SNAPSHOT, request);
}

export async function machineScmDiffFile(
    machineId: string,
    request: ScmDiffFileRequest,
): Promise<ScmDiffFileResponse> {
    return await callMachineScm<ScmDiffFileResponse, ScmDiffFileRequest>(machineId, RPC_METHODS.SCM_DIFF_FILE, request);
}

export async function machineScmDiffCommit(
    machineId: string,
    request: ScmDiffCommitRequest,
): Promise<ScmDiffCommitResponse> {
    return await callMachineScm<ScmDiffCommitResponse, ScmDiffCommitRequest>(machineId, RPC_METHODS.SCM_DIFF_COMMIT, request);
}

export async function machineScmChangeInclude(
    machineId: string,
    request: ScmChangeApplyRequest,
): Promise<ScmChangeApplyResponse> {
    return await callMachineScm<ScmChangeApplyResponse, ScmChangeApplyRequest>(machineId, RPC_METHODS.SCM_CHANGE_INCLUDE, request);
}

export async function machineScmChangeExclude(
    machineId: string,
    request: ScmChangeApplyRequest,
): Promise<ScmChangeApplyResponse> {
    return await callMachineScm<ScmChangeApplyResponse, ScmChangeApplyRequest>(machineId, RPC_METHODS.SCM_CHANGE_EXCLUDE, request);
}

export async function machineScmChangeDiscard(
    machineId: string,
    request: ScmChangeDiscardRequest,
): Promise<ScmChangeDiscardResponse> {
    return await callMachineScm<ScmChangeDiscardResponse, ScmChangeDiscardRequest>(machineId, RPC_METHODS.SCM_CHANGE_DISCARD, request);
}

export async function machineScmCommitCreate(
    machineId: string,
    request: ScmCommitCreateRequest,
): Promise<ScmCommitCreateResponse> {
    return await callMachineScm<ScmCommitCreateResponse, ScmCommitCreateRequest>(machineId, RPC_METHODS.SCM_COMMIT_CREATE, request);
}

export async function machineScmLogList(
    machineId: string,
    request: ScmLogListRequest,
): Promise<ScmLogListResponse> {
    return await callMachineScm<ScmLogListResponse, ScmLogListRequest>(machineId, RPC_METHODS.SCM_LOG_LIST, request);
}

export async function machineScmCommitBackout(
    machineId: string,
    request: ScmCommitBackoutRequest,
): Promise<ScmCommitBackoutResponse> {
    return await callMachineScm<ScmCommitBackoutResponse, ScmCommitBackoutRequest>(machineId, RPC_METHODS.SCM_COMMIT_BACKOUT, request);
}

export async function machineScmRemoteFetch(
    machineId: string,
    request: ScmRemoteRequest,
): Promise<ScmRemoteResponse> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_FETCH, request);
}

export async function machineScmRemotePush(
    machineId: string,
    request: ScmRemoteRequest,
): Promise<ScmRemoteResponse> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_PUSH, request);
}

export async function machineScmRemotePull(
    machineId: string,
    request: ScmRemoteRequest,
): Promise<ScmRemoteResponse> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_PULL, request);
}

export async function machineScmBranchList(
    machineId: string,
    request: ScmBranchListRequest,
): Promise<ScmBranchListResponse> {
    return await callMachineScm<ScmBranchListResponse, ScmBranchListRequest>(machineId, RPC_METHODS.SCM_BRANCH_LIST, request);
}

export async function machineScmBranchCreate(
    machineId: string,
    request: ScmBranchCreateRequest,
): Promise<ScmBranchCreateResponse> {
    return await callMachineScm<ScmBranchCreateResponse, ScmBranchCreateRequest>(machineId, RPC_METHODS.SCM_BRANCH_CREATE, request);
}

export async function machineScmBranchCheckout(
    machineId: string,
    request: ScmBranchCheckoutRequest,
): Promise<ScmBranchCheckoutResponse> {
    return await callMachineScm<ScmBranchCheckoutResponse, ScmBranchCheckoutRequest>(machineId, RPC_METHODS.SCM_BRANCH_CHECKOUT, request);
}

export async function machineScmWorktreeCreate(
    machineId: string,
    request: ScmWorktreeCreateRequest,
): Promise<ScmWorktreeCreateResponse> {
    return await callMachineScm<ScmWorktreeCreateResponse, ScmWorktreeCreateRequest>(machineId, RPC_METHODS.SCM_WORKTREE_CREATE, request);
}

export async function machineScmWorktreeRemove(
    machineId: string,
    request: ScmWorktreeRemoveRequest,
): Promise<ScmWorktreeRemoveResponse> {
    return await callMachineScm<ScmWorktreeRemoveResponse, ScmWorktreeRemoveRequest>(machineId, RPC_METHODS.SCM_WORKTREE_REMOVE, request);
}

export async function machineScmWorktreePrune(
    machineId: string,
    request: ScmWorktreePruneRequest,
): Promise<ScmWorktreePruneResponse> {
    return await callMachineScm<ScmWorktreePruneResponse, ScmWorktreePruneRequest>(machineId, RPC_METHODS.SCM_WORKTREE_PRUNE, request);
}

export async function machineScmRemotePublish(
    machineId: string,
    request: ScmRemotePublishRequest,
): Promise<ScmRemotePublishResponse> {
    return await callMachineScm<ScmRemotePublishResponse, ScmRemotePublishRequest>(machineId, RPC_METHODS.SCM_REMOTE_PUBLISH, request);
}

export async function machineScmStashList(
    machineId: string,
    request: ScmStashListRequest,
): Promise<ScmStashListResponse> {
    return await callMachineScm<ScmStashListResponse, ScmStashListRequest>(machineId, RPC_METHODS.SCM_STASH_LIST, request);
}

export async function machineScmStashDrop(
    machineId: string,
    request: ScmStashDropRequest,
): Promise<ScmStashDropResponse> {
    return await callMachineScm<ScmStashDropResponse, ScmStashDropRequest>(machineId, RPC_METHODS.SCM_STASH_DROP, request);
}

export async function machineScmStashPop(
    machineId: string,
    request: ScmStashPopRequest,
): Promise<ScmStashPopResponse> {
    return await callMachineScm<ScmStashPopResponse, ScmStashPopRequest>(machineId, RPC_METHODS.SCM_STASH_POP, request);
}

export async function machineScmStashApply(
    machineId: string,
    request: ScmStashApplyRequest,
): Promise<ScmStashApplyResponse> {
    return await callMachineScm<ScmStashApplyResponse, ScmStashApplyRequest>(machineId, RPC_METHODS.SCM_STASH_APPLY, request);
}

export async function machineScmStashShow(
    machineId: string,
    request: ScmStashShowRequest,
): Promise<ScmStashShowResponse> {
    return await callMachineScm<ScmStashShowResponse, ScmStashShowRequest>(machineId, RPC_METHODS.SCM_STASH_SHOW, request);
}
