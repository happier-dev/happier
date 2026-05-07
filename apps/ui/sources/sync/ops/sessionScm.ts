import type {
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchListRequest,
    ScmBranchListResponse,
    ScmBranchOperationControlRequest,
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
    ScmPullRequestCheckoutRequest,
    ScmPullRequestCheckoutResponse,
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmPullRequestPrepareWorktreeRequest,
    ScmPullRequestPrepareWorktreeResponse,
    ScmPullRequestRunStackedRequest,
    ScmPullRequestRunStackedResponse,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmRemoteSetUrlRequest,
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

export async function sessionScmRemoteAdd(
    sessionId: string,
    request: ScmRemoteAddRequest
): Promise<ScmRemoteManagementResponse> {
    return await callScmPreferMachine<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_ADD,
        request
    );
}

export async function sessionScmRemoteSetUrl(
    sessionId: string,
    request: ScmRemoteSetUrlRequest
): Promise<ScmRemoteManagementResponse> {
    return await callScmPreferMachine<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_SET_URL,
        request
    );
}

export async function sessionScmRemoteRemove(
    sessionId: string,
    request: ScmRemoteRemoveRequest
): Promise<ScmRemoteManagementResponse> {
    return await callScmPreferMachine<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_REMOVE,
        request
    );
}

export async function sessionScmRepositoryInit(
    sessionId: string,
    request: ScmRepositoryInitRequest,
): Promise<ScmRepositoryInitResponse> {
    return await callScmPreferMachine<ScmRepositoryInitResponse, ScmRepositoryInitRequest>(
        sessionId,
        RPC_METHODS.SCM_REPOSITORY_INIT,
        request,
    );
}

export async function sessionScmRepositoryRemoveIndexLock(
    sessionId: string,
    request: ScmRepositoryRemoveIndexLockRequest,
): Promise<ScmRepositoryRemoveIndexLockResponse> {
    return await callScmPreferMachine<ScmRepositoryRemoveIndexLockResponse, ScmRepositoryRemoveIndexLockRequest>(
        sessionId,
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        request,
    );
}

export async function sessionScmHostingRepositoryDescribePublishTargets(
    sessionId: string,
    request: ScmHostingRepositoryDescribePublishTargetsRequest,
): Promise<ScmHostingRepositoryDescribePublishTargetsResponse> {
    return await callScmPreferMachine<
        ScmHostingRepositoryDescribePublishTargetsResponse,
        ScmHostingRepositoryDescribePublishTargetsRequest
    >(
        sessionId,
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        request,
    );
}

export async function sessionScmHostingRepositoryPublish(
    sessionId: string,
    request: ScmHostingRepositoryPublishRequest,
): Promise<ScmHostingRepositoryPublishResponse> {
    return await callScmPreferMachine<ScmHostingRepositoryPublishResponse, ScmHostingRepositoryPublishRequest>(
        sessionId,
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        request,
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

export async function sessionScmBranchMerge(
    sessionId: string,
    request: ScmBranchIntegrationRequest
): Promise<ScmBranchIntegrationResponse> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_MERGE,
        request
    );
}

export async function sessionScmBranchRebase(
    sessionId: string,
    request: ScmBranchIntegrationRequest
): Promise<ScmBranchIntegrationResponse> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_REBASE,
        request
    );
}

export async function sessionScmBranchOperationContinue(
    sessionId: string,
    request: ScmBranchOperationControlRequest
): Promise<ScmBranchIntegrationResponse> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        request
    );
}

export async function sessionScmBranchOperationAbort(
    sessionId: string,
    request: ScmBranchOperationControlRequest
): Promise<ScmBranchIntegrationResponse> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
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

export async function sessionScmPullRequestList(
    sessionId: string,
    request: ScmPullRequestListRequest,
): Promise<ScmPullRequestListResponse> {
    return await callScmPreferMachine<ScmPullRequestListResponse, ScmPullRequestListRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_LIST,
        request,
    );
}

export async function sessionScmPullRequestGet(
    sessionId: string,
    request: ScmPullRequestGetRequest,
): Promise<ScmPullRequestGetResponse> {
    return await callScmPreferMachine<ScmPullRequestGetResponse, ScmPullRequestGetRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_GET,
        request,
    );
}

export async function sessionScmPullRequestOpenCompose(
    sessionId: string,
    request: ScmPullRequestOpenComposeRequest,
): Promise<ScmPullRequestOpenComposeResponse> {
    return await callScmPreferMachine<ScmPullRequestOpenComposeResponse, ScmPullRequestOpenComposeRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        request,
    );
}

export async function sessionScmPullRequestOpenOrReuse(
    sessionId: string,
    request: ScmPullRequestOpenOrReuseRequest,
): Promise<ScmPullRequestOpenOrReuseResponse> {
    return await callScmPreferMachine<ScmPullRequestOpenOrReuseResponse, ScmPullRequestOpenOrReuseRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        request,
    );
}

export async function sessionScmPullRequestCheckout(
    sessionId: string,
    request: ScmPullRequestCheckoutRequest,
): Promise<ScmPullRequestCheckoutResponse> {
    return await callScmPreferMachine<ScmPullRequestCheckoutResponse, ScmPullRequestCheckoutRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
        request,
    );
}

export async function sessionScmPullRequestPrepareWorktree(
    sessionId: string,
    request: ScmPullRequestPrepareWorktreeRequest,
): Promise<ScmPullRequestPrepareWorktreeResponse> {
    return await callScmPreferMachine<ScmPullRequestPrepareWorktreeResponse, ScmPullRequestPrepareWorktreeRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
        request,
    );
}

export async function sessionScmPullRequestRunStacked(
    sessionId: string,
    request: ScmPullRequestRunStackedRequest,
): Promise<ScmPullRequestRunStackedResponse> {
    return await callScmPreferMachine<ScmPullRequestRunStackedResponse, ScmPullRequestRunStackedRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
        request,
    );
}
