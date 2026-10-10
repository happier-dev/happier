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
    ScmConflictAcceptSideRequest,
    ScmConflictMarkResolvedRequest,
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
    ScmChangeDiscardRequest,
    ScmChangeDiscardResponse,
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
    ScmCommitUndoLastRequest,
    ScmCommitUndoLastResponse,
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmDiffFileRequest,
    ScmDiffFileResponse,
    ScmLogListRequest,
    ScmLogListResponse,
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmRemoteSetUrlRequest,
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
    ScmStashApplyRequest,
    ScmStashApplyResponse,
    ScmStashDropRequest,
    ScmStashCreateRequest,
    ScmStashCreateResponse,
    ScmStashDropResponse,
    ScmStashListRequest,
    ScmStashListResponse,
    ScmStashPopRequest,
    ScmStashPopResponse,
    ScmStashShowRequest,
    ScmStashShowResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotTransportResponse,
} from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getScmRpcSideEffectClass } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { runMachineScmRpcWithFallback } from './scm/machineScm';
import type { ScmRpcFailure } from './scm/scmRpcFailure';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { invokeUiScmAction, normalizeUiScmFacadeResult } from './scm/scmActionInvocation';

async function callScmPreferMachineTransport<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends { cwd?: string; backendPreference?: unknown }
>(
    sessionId: string,
    method: string,
    request: R,
    serverId?: string | null,
    signal?: AbortSignal,
    accountId?: string | null,
    bindResolvedRequest?: (request: R & { cwd: string }) => R & { cwd: string },
): Promise<T | ScmRpcFailure> {
    const workEvidence = (method === RPC_METHODS.SCM_BRANCH_LIST || method === RPC_METHODS.SCM_PULL_REQUEST_LIST || method === RPC_METHODS.SCM_PULL_REQUEST_GET)
        && 'workEvidence' in request ? request.workEvidence : undefined;
    if (workEvidence !== undefined && (!workEvidence || typeof workEvidence !== 'object'
        || !('sessionId' in workEvidence) || workEvidence.sessionId !== sessionId)) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid Work Session scope' };
    }
    const machineTarget = readMachineControlTargetForSession(
        serverId === undefined ? sessionId : { sessionId, serverId: serverId ?? '', ...(accountId ? { accountId } : {}) },
    );

    if (!machineTarget) {
        return {
            success: false,
            error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        };
    }

    const cwd = resolveMachineAbsolutePath({
        rootPath: machineTarget.basePath,
        agentRootPath: machineTarget.agentBasePath,
        requestPath: request.cwd,
    });
    const resolvedServerId = serverId === undefined
        ? resolvePreferredServerIdForSessionId(sessionId)
        : serverId;
    const payload = bindResolvedRequest ? bindResolvedRequest({ ...request, cwd }) : { ...request, cwd };
    return await runMachineScmRpcWithFallback<T, R>(
        machineTarget.machineId,
        method,
        payload,
        { serverId: resolvedServerId, ...(signal ? { signal } : {}), ...(accountId ? { accountId } : {}),
            ...(method.startsWith('scm.diffSummary.') || workEvidence !== undefined
                ? { authorization: { kind: 'session.write' as const, sessionId } } : {}) },
    );
}

// Actions and typed facades share the exact session target/path transport owner.
export { callScmPreferMachineTransport as runSessionScmRpc };

async function callScmPreferMachine<T extends { success: boolean; error?: string; errorCode?: string }, R extends { cwd?: string; backendPreference?: unknown }>(
    sessionId: string, method: string, request: R, serverId?: string | null,
): Promise<T | ScmRpcFailure> {
    if (getScmRpcSideEffectClass(method) === 'read' && method !== RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE) {
        return callScmPreferMachineTransport<T, R>(sessionId, method, request, serverId);
    }
    const actionId = ActionIdSchema.parse(method);
    const schema = getActionSpec(actionId).outputSchema;
    if (!schema) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'The SCM Action has no result contract.' };
    const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
    // Preserve the ordinary facade's caller-relative path contract through its
    // existing Session target owner, beneath canonical Action admission.
    const executor = createDefaultActionExecutor({ scmActionExecute: ({ input, context }) =>
        callScmPreferMachineTransport(sessionId, method, input as R, context.serverId ?? serverId, context.signal, context.runtimeAccountId) });
    const result: unknown = await invokeUiScmAction({ actionId, input: request, schema, executor,
        context: { defaultSessionId: sessionId, externalActionTarget: { kind: 'session', sessionId },
            ...(serverId ? { serverId } : {}),
        } });
    return normalizeUiScmFacadeResult<T>(result);
}

export async function sessionScmStatusSnapshot(
    sessionId: string,
    request: ScmStatusSnapshotRequest,
    serverId?: string | null,
): Promise<ScmStatusSnapshotTransportResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStatusSnapshotTransportResponse, ScmStatusSnapshotRequest>(
        sessionId,
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        request,
        serverId,
    );
}

export async function sessionScmDiffFile(
    sessionId: string,
    request: ScmDiffFileRequest,
    serverId?: string | null,
): Promise<ScmDiffFileResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmDiffFileResponse, ScmDiffFileRequest>(
        sessionId,
        RPC_METHODS.SCM_DIFF_FILE,
        request,
        serverId,
    );
}

export async function sessionScmDiffCommit(
    sessionId: string,
    request: ScmDiffCommitRequest,
    serverId?: string | null,
): Promise<ScmDiffCommitResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmDiffCommitResponse, ScmDiffCommitRequest>(
        sessionId,
        RPC_METHODS.SCM_DIFF_COMMIT,
        request,
        serverId,
    );
}

export async function sessionScmChangeInclude(
    sessionId: string,
    request: ScmChangeApplyRequest,
    serverId?: string | null,
): Promise<ScmChangeApplyResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmChangeApplyResponse, ScmChangeApplyRequest>(
        sessionId,
        RPC_METHODS.SCM_CHANGE_INCLUDE,
        request,
        serverId,
    );
}

export async function sessionScmChangeExclude(
    sessionId: string,
    request: ScmChangeApplyRequest,
    serverId?: string | null,
): Promise<ScmChangeApplyResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmChangeApplyResponse, ScmChangeApplyRequest>(
        sessionId,
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        request,
        serverId,
    );
}

export async function sessionScmChangeDiscard(
    sessionId: string,
    request: ScmChangeDiscardRequest,
    serverId?: string | null,
): Promise<ScmChangeDiscardResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmChangeDiscardResponse, ScmChangeDiscardRequest>(
        sessionId,
        RPC_METHODS.SCM_CHANGE_DISCARD,
        request,
        serverId,
    );
}

export async function sessionScmCommitCreate(
    sessionId: string,
    request: ScmCommitCreateRequest,
    serverId?: string | null,
): Promise<ScmCommitCreateResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmCommitCreateResponse, ScmCommitCreateRequest>(
        sessionId,
        RPC_METHODS.SCM_COMMIT_CREATE,
        request,
        serverId,
    );
}

export async function sessionScmCommitUndoLast(
    sessionId: string,
    request: ScmCommitUndoLastRequest,
    serverId?: string | null,
): Promise<ScmCommitUndoLastResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmCommitUndoLastResponse, ScmCommitUndoLastRequest>(
        sessionId,
        RPC_METHODS.SCM_COMMIT_UNDO_LAST,
        request,
        serverId,
    );
}

export async function sessionScmLogList(
    sessionId: string,
    request: ScmLogListRequest,
    serverId?: string | null,
): Promise<ScmLogListResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmLogListResponse, ScmLogListRequest>(
        sessionId,
        RPC_METHODS.SCM_LOG_LIST,
        request,
        serverId,
    );
}

export async function sessionScmCommitBackout(
    sessionId: string,
    request: ScmCommitBackoutRequest,
    serverId?: string | null,
): Promise<ScmCommitBackoutResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmCommitBackoutResponse, ScmCommitBackoutRequest>(
        sessionId,
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        request,
        serverId,
    );
}

export async function sessionScmRemoteFetch(
    sessionId: string,
    request: ScmRemoteRequest,
    serverId?: string | null,
): Promise<ScmRemoteResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemoteResponse, ScmRemoteRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_FETCH,
        request,
        serverId,
    );
}

export async function sessionScmRemotePush(
    sessionId: string,
    request: ScmRemoteRequest,
    serverId?: string | null,
): Promise<ScmRemoteResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemoteResponse, ScmRemoteRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_PUSH,
        request,
        serverId,
    );
}

export async function sessionScmRemotePull(
    sessionId: string,
    request: ScmRemoteRequest,
    serverId?: string | null,
): Promise<ScmRemoteResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemoteResponse, ScmRemoteRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_PULL,
        request,
        serverId,
    );
}

export async function sessionScmBranchList(
    sessionId: string,
    request: ScmBranchListRequest,
    serverId?: string | null,
): Promise<ScmBranchListResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchListResponse, ScmBranchListRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_LIST,
        request,
        serverId,
    );
}

export async function sessionScmBranchCreate(
    sessionId: string,
    request: ScmBranchCreateRequest,
    serverId?: string | null,
): Promise<ScmBranchCreateResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchCreateResponse, ScmBranchCreateRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_CREATE,
        request,
        serverId,
    );
}

export async function sessionScmBranchCheckout(
    sessionId: string,
    request: ScmBranchCheckoutRequest,
    serverId?: string | null,
): Promise<ScmBranchCheckoutResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchCheckoutResponse, ScmBranchCheckoutRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        request,
        serverId,
    );
}

export async function sessionScmBranchMerge(
    sessionId: string,
    request: ScmBranchIntegrationRequest,
    serverId?: string | null,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_MERGE,
        request,
        serverId,
    );
}

export async function sessionScmBranchRebase(
    sessionId: string,
    request: ScmBranchIntegrationRequest,
    serverId?: string | null,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_REBASE,
        request,
        serverId,
    );
}

export async function sessionScmBranchOperationContinue(
    sessionId: string,
    request: ScmBranchOperationControlRequest,
    serverId?: string | null,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        request,
        serverId,
    );
}

export async function sessionScmBranchOperationAbort(
    sessionId: string,
    request: ScmBranchOperationControlRequest,
    serverId?: string | null,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(
        sessionId,
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
        request,
        serverId,
    );
}

export async function sessionScmBranchOperationSkip(sessionId: string, request: ScmBranchOperationControlRequest, serverId?: string | null): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return callScmPreferMachine(sessionId, RPC_METHODS.SCM_BRANCH_OPERATION_SKIP, request, serverId);
}

export async function sessionScmConflictAcceptSide(sessionId: string, request: ScmConflictAcceptSideRequest, serverId?: string | null): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return callScmPreferMachine(sessionId, RPC_METHODS.SCM_CONFLICT_ACCEPT_SIDE, request, serverId);
}

export async function sessionScmConflictMarkResolved(sessionId: string, request: ScmConflictMarkResolvedRequest, serverId?: string | null): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return callScmPreferMachine(sessionId, RPC_METHODS.SCM_CONFLICT_MARK_RESOLVED, request, serverId);
}

export async function sessionScmRemotePublish(
    sessionId: string,
    request: ScmRemotePublishRequest,
    serverId?: string | null,
): Promise<ScmRemotePublishResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemotePublishResponse, ScmRemotePublishRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        request,
        serverId,
    );
}

export async function sessionScmRemoteAdd(
    sessionId: string,
    request: ScmRemoteAddRequest,
    serverId?: string | null,
): Promise<ScmRemoteManagementResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_ADD,
        request,
        serverId,
    );
}

export async function sessionScmRemoteSetUrl(
    sessionId: string,
    request: ScmRemoteSetUrlRequest,
    serverId?: string | null,
): Promise<ScmRemoteManagementResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_SET_URL,
        request,
        serverId,
    );
}

export async function sessionScmRemoteRemove(
    sessionId: string,
    request: ScmRemoteRemoveRequest,
    serverId?: string | null,
): Promise<ScmRemoteManagementResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(
        sessionId,
        RPC_METHODS.SCM_REMOTE_REMOVE,
        request,
        serverId,
    );
}

export async function sessionScmPullRequestList(
    sessionId: string,
    request: ScmPullRequestListRequest,
    serverId?: string | null,
): Promise<ScmPullRequestListResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmPullRequestListResponse, ScmPullRequestListRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_LIST,
        request,
        serverId,
    );
}

export async function sessionScmPullRequestGet(
    sessionId: string,
    request: ScmPullRequestGetRequest,
    serverId?: string | null,
): Promise<ScmPullRequestGetResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmPullRequestGetResponse, ScmPullRequestGetRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_GET,
        request,
        serverId,
    );
}

export async function sessionScmPullRequestOpenCompose(
    sessionId: string,
    request: ScmPullRequestOpenComposeRequest,
    serverId?: string | null,
): Promise<ScmPullRequestOpenComposeResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmPullRequestOpenComposeResponse, ScmPullRequestOpenComposeRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        request,
        serverId,
    );
}

export async function sessionScmPullRequestOpenOrReuse(
    sessionId: string,
    request: ScmPullRequestOpenOrReuseRequest,
    serverId?: string | null,
): Promise<ScmPullRequestOpenOrReuseResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmPullRequestOpenOrReuseResponse, ScmPullRequestOpenOrReuseRequest>(
        sessionId,
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        request,
        serverId,
    );
}

export async function sessionScmRepositoryInit(
    sessionId: string,
    request: ScmRepositoryInitRequest,
    serverId?: string | null,
): Promise<ScmRepositoryInitResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRepositoryInitResponse, ScmRepositoryInitRequest>(
        sessionId,
        RPC_METHODS.SCM_REPOSITORY_INIT,
        request,
        serverId,
    );
}

export async function sessionScmHostingRepositoryDescribePublishTargets(
    sessionId: string,
    request: ScmHostingRepositoryDescribePublishTargetsRequest,
    serverId?: string | null,
): Promise<ScmHostingRepositoryDescribePublishTargetsResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmHostingRepositoryDescribePublishTargetsResponse, ScmHostingRepositoryDescribePublishTargetsRequest>(
        sessionId,
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        request,
        serverId,
    );
}

export async function sessionScmHostingRepositoryPublish(
    sessionId: string,
    request: ScmHostingRepositoryPublishRequest,
    serverId?: string | null,
): Promise<ScmHostingRepositoryPublishResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmHostingRepositoryPublishResponse, ScmHostingRepositoryPublishRequest>(
        sessionId,
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        request,
        serverId,
    );
}

export async function sessionScmRepositoryRemoveIndexLock(
    sessionId: string,
    request: ScmRepositoryRemoveIndexLockRequest,
    serverId?: string | null,
): Promise<ScmRepositoryRemoveIndexLockResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmRepositoryRemoveIndexLockResponse, ScmRepositoryRemoveIndexLockRequest>(
        sessionId,
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        request,
        serverId,
    );
}

export async function sessionScmStashList(
    sessionId: string,
    request: ScmStashListRequest,
    serverId?: string | null,
): Promise<ScmStashListResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStashListResponse, ScmStashListRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_LIST,
        request,
        serverId,
    );
}

export async function sessionScmStashCreate(
    sessionId: string,
    request: ScmStashCreateRequest,
    serverId?: string | null,
): Promise<ScmStashCreateResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStashCreateResponse, ScmStashCreateRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_CREATE,
        request,
        serverId,
    );
}

export async function sessionScmStashDrop(
    sessionId: string,
    request: ScmStashDropRequest,
    serverId?: string | null,
): Promise<ScmStashDropResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStashDropResponse, ScmStashDropRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_DROP,
        request,
        serverId,
    );
}

export async function sessionScmStashPop(
    sessionId: string,
    request: ScmStashPopRequest,
    serverId?: string | null,
): Promise<ScmStashPopResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStashPopResponse, ScmStashPopRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_POP,
        request,
        serverId,
    );
}

export async function sessionScmStashApply(
    sessionId: string,
    request: ScmStashApplyRequest,
    serverId?: string | null,
): Promise<ScmStashApplyResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStashApplyResponse, ScmStashApplyRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_APPLY,
        request,
        serverId,
    );
}

export async function sessionScmStashShow(
    sessionId: string,
    request: ScmStashShowRequest,
    serverId?: string | null,
): Promise<ScmStashShowResponse | ScmRpcFailure> {
    return await callScmPreferMachine<ScmStashShowResponse, ScmStashShowRequest>(
        sessionId,
        RPC_METHODS.SCM_STASH_SHOW,
        request,
        serverId,
    );
}
