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
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { assertScmResponse, runMachineScmRpc, scmFallbackError, withScmBackendPreference } from './scm/machineScm';
import { canUseSessionRpc, readMachineTargetForSession, resolveMachinePathFromSessionBase, shouldFallbackToSessionRpc } from './sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

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
        try {
            return await runMachineScmRpc<T, R>(
                machineTarget.machineId,
                method,
                { ...request, cwd } as R,
            );
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
        const response = await sessionRpcWithServerScope<T, R>({
            sessionId,
            serverId: resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload: withScmBackendPreference(request),
        });
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

export async function sessionScmBranchList(
    sessionId: string,
    request: ScmBranchListRequest
): Promise<ScmBranchListResponse> {
    return await callScmPreferMachine<ScmBranchListResponse, ScmBranchListRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_LIST,
        request
    );
}

export async function sessionScmBranchCreate(
    sessionId: string,
    request: ScmBranchCreateRequest
): Promise<ScmBranchCreateResponse> {
    return await callScmPreferMachine<ScmBranchCreateResponse, ScmBranchCreateRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_CREATE,
        request
    );
}

export async function sessionScmBranchCheckout(
    sessionId: string,
    request: ScmBranchCheckoutRequest
): Promise<ScmBranchCheckoutResponse> {
    return await callScmPreferMachine<ScmBranchCheckoutResponse, ScmBranchCheckoutRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        request
    );
}

export async function sessionScmRemotePublish(
    sessionId: string,
    request: ScmRemotePublishRequest
): Promise<ScmRemotePublishResponse> {
    return await callScmPreferMachine<ScmRemotePublishResponse, ScmRemotePublishRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        request
    );
}

export async function sessionScmStashList(
    sessionId: string,
    request: ScmStashListRequest
): Promise<ScmStashListResponse> {
    return await callScmPreferMachine<ScmStashListResponse, ScmStashListRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_LIST,
        request
    );
}

export async function sessionScmStashDrop(
    sessionId: string,
    request: ScmStashDropRequest
): Promise<ScmStashDropResponse> {
    return await callScmPreferMachine<ScmStashDropResponse, ScmStashDropRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_DROP,
        request
    );
}

export async function sessionScmStashPop(
    sessionId: string,
    request: ScmStashPopRequest
): Promise<ScmStashPopResponse> {
    return await callScmPreferMachine<ScmStashPopResponse, ScmStashPopRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_POP,
        request
    );
}

export async function sessionScmStashApply(
    sessionId: string,
    request: ScmStashApplyRequest
): Promise<ScmStashApplyResponse> {
    return await callScmPreferMachine<ScmStashApplyResponse, ScmStashApplyRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_APPLY,
        request
    );
}

export async function sessionScmStashShow(
    sessionId: string,
    request: ScmStashShowRequest
): Promise<ScmStashShowResponse> {
    return await callScmPreferMachine<ScmStashShowResponse, ScmStashShowRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_SHOW,
        request
    );
}
