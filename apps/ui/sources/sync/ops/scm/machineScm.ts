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
    ScmDiffSummaryResultClearInput,
    ScmLogListRequest,
    ScmLogListResponse,
    ScmHistoryEntriesRequest,
    ScmHistoryEntriesResponse,
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
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES, ScmLogListResponseSchema, ScmHistoryEntriesResponseSchema } from '@happier-dev/protocol/scm';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS, type SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { getScmRpcSideEffectClass } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { scmFallbackError, type ScmRpcFailure } from './scmRpcFailure';
import { runScmRpcWithAdmission } from './scmRpcAdmission';
import { invokeUiScmAction, normalizeUiScmFacadeResult } from './scmActionInvocation';
export { assertScmResponse, scmFallbackError } from './scmRpcFailure';

import { storage } from '@/sync/domains/state/storage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
    normalizeScmGitRepoPreferredBackend,
    resolveScmGitRepoPreferredBackendId,
} from '@/scm/settings/preferences';
import { getFirstPartyScmBackendLegacyLocalId } from '@/scm/registry/firstPartyScmBackendIdentity';

const SCM_DIFF_COMMIT_TIMEOUT_MS = 120_000;

export type MachineScmCallOptions = Readonly<{
    serverId?: string | null;
    accountId?: string | null;
    signal?: AbortSignal;
    authorization?: SocketRpcAuthorizationContext;
}>;

type MachineScmRpcRequest = Readonly<{
    cwd?: string;
    backendPreference?: unknown;
    results?: ScmDiffSummaryResultClearInput['results'];
}>;

function resolveScmRpcTimeoutMs(method: string): number | undefined {
    if (method === RPC_METHODS.SCM_DIFF_COMMIT) {
        return SCM_DIFF_COMMIT_TIMEOUT_MS;
    }
    return undefined;
}

export function withScmBackendPreference<T extends { backendPreference?: unknown }>(request: T): T {
    const settings = storage.getState().settings;
    const legacyPreference = normalizeScmGitRepoPreferredBackend(settings.scmGitRepoPreferredBackend);
    const preferredBackendId = resolveScmGitRepoPreferredBackendId({
        legacyPreference,
        qualifiedPreference: settings.scmGitRepoPreferredBackendQualifiedId,
    });
    const wireBackendId = getFirstPartyScmBackendLegacyLocalId(preferredBackendId)
        ?? preferredBackendId;

    if (wireBackendId !== 'git') {
        return {
            ...request,
            backendPreference: {
                kind: 'prefer',
                backendId: wireBackendId,
            },
        };
    }
    return request;
}

export async function runMachineScmRpc<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends MachineScmRpcRequest
>(
    machineId: string,
    method: string,
    request: R,
    options?: MachineScmCallOptions,
): Promise<T | ScmRpcFailure> {
    const payload = method.startsWith('scm.diffSummary.') || method === 'scm.hostingRepository.resolveAddress' ? request : withScmBackendPreference({
        ...request,
        outcomeVersion: 1 as const,
        ...(method === RPC_METHODS.SCM_STATUS_SNAPSHOT ? { operationStateVersion: 1 as const } : {}),
    });
    return await runScmRpcWithAdmission<T>({
        method, request: payload,
        call: (rpcMethod, rpcPayload) => machineRpcWithServerScope<unknown, object>({
            machineId,
            method: rpcMethod,
            payload: rpcPayload,
            ...(options?.serverId ? { serverId: options.serverId } : {}),
            ...(options?.accountId ? { accountId: options.accountId } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.authorization ? { authorization: options.authorization } : {}),
            timeoutMs: resolveScmRpcTimeoutMs(rpcMethod),
        }),
    });
}

async function callMachineScmTransport<
    T extends { success: boolean; error?: string; errorCode?: string },
    R extends MachineScmRpcRequest
>(
    machineId: string,
    method: string,
    request: R,
    options?: MachineScmCallOptions,
): Promise<T | ScmRpcFailure> {
    try {
        return await runMachineScmRpc<T, R>(machineId, method, request, options);
    } catch (error) {
        // A caller-cancelled search must reach the caller as an abort so it can discard the
        // request silently — not be reclassified as a backend failure, which would present
        // offline truth for a query the user simply left. This matches the typed
        // workspace-file adapter's cancellation discipline.
        if (options?.signal?.aborted && getScmRpcSideEffectClass(method) === 'read') {
            throw error;
        }
        return scmFallbackError(error, { method, request });
    }
}

// The Action family shares typed facades' cancellation and uncertain-write handling.
export { callMachineScmTransport as runMachineScmRpcWithFallback };

async function callMachineScm<T extends { success: boolean; error?: string; errorCode?: string }, R extends MachineScmRpcRequest>(
    machineId: string, method: string, request: R, options?: MachineScmCallOptions,
): Promise<T | ScmRpcFailure> {
    // Passive snapshot/diff observations retain the transport's cancellation contract.
    // Intentional effects and PR draft preparation enter the shared Action owner.
    if (getScmRpcSideEffectClass(method) === 'read' && method !== RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE) {
        return callMachineScmTransport<T, R>(machineId, method, request, options);
    }
    const actionId = ActionIdSchema.parse(method);
    const schema = getActionSpec(actionId).outputSchema;
    if (!schema) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'The SCM Action has no result contract.' };
    const result: unknown = await invokeUiScmAction({ actionId, input: request, schema,
        context: { externalActionTarget: { kind: 'machine', machineId },
            ...(options?.serverId ? { serverId: options.serverId } : {}),
            ...(options?.accountId ? { expectedAccountId: options.accountId } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
        } });
    return normalizeUiScmFacadeResult<T>(result);
}

export async function machineScmStatusSnapshot(
    machineId: string,
    request: ScmStatusSnapshotRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStatusSnapshotTransportResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStatusSnapshotTransportResponse, ScmStatusSnapshotRequest>(machineId, RPC_METHODS.SCM_STATUS_SNAPSHOT, request, options);
}

export async function machineScmDiffFile(
    machineId: string,
    request: ScmDiffFileRequest,
    options?: MachineScmCallOptions,
): Promise<ScmDiffFileResponse | ScmRpcFailure> {
    return await callMachineScm<ScmDiffFileResponse, ScmDiffFileRequest>(machineId, RPC_METHODS.SCM_DIFF_FILE, request, options);
}

export async function machineScmDiffCommit(
    machineId: string,
    request: ScmDiffCommitRequest,
    options?: MachineScmCallOptions,
): Promise<ScmDiffCommitResponse | ScmRpcFailure> {
    return await callMachineScm<ScmDiffCommitResponse, ScmDiffCommitRequest>(machineId, RPC_METHODS.SCM_DIFF_COMMIT, request, options);
}

export async function machineScmChangeInclude(
    machineId: string,
    request: ScmChangeApplyRequest,
    options?: MachineScmCallOptions,
): Promise<ScmChangeApplyResponse | ScmRpcFailure> {
    return await callMachineScm<ScmChangeApplyResponse, ScmChangeApplyRequest>(machineId, RPC_METHODS.SCM_CHANGE_INCLUDE, request, options);
}

export async function machineScmChangeExclude(
    machineId: string,
    request: ScmChangeApplyRequest,
    options?: MachineScmCallOptions,
): Promise<ScmChangeApplyResponse | ScmRpcFailure> {
    return await callMachineScm<ScmChangeApplyResponse, ScmChangeApplyRequest>(machineId, RPC_METHODS.SCM_CHANGE_EXCLUDE, request, options);
}

export async function machineScmChangeDiscard(
    machineId: string,
    request: ScmChangeDiscardRequest,
    options?: MachineScmCallOptions,
): Promise<ScmChangeDiscardResponse | ScmRpcFailure> {
    return await callMachineScm<ScmChangeDiscardResponse, ScmChangeDiscardRequest>(machineId, RPC_METHODS.SCM_CHANGE_DISCARD, request, options);
}

export async function machineScmCommitCreate(
    machineId: string,
    request: ScmCommitCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmCommitCreateResponse | ScmRpcFailure> {
    return await callMachineScm<ScmCommitCreateResponse, ScmCommitCreateRequest>(machineId, RPC_METHODS.SCM_COMMIT_CREATE, request, options);
}

export async function machineScmCommitUndoLast(
    machineId: string,
    request: ScmCommitUndoLastRequest,
    options?: MachineScmCallOptions,
): Promise<ScmCommitUndoLastResponse | ScmRpcFailure> {
    return await callMachineScm<ScmCommitUndoLastResponse, ScmCommitUndoLastRequest>(machineId, RPC_METHODS.SCM_COMMIT_UNDO_LAST, request, options);
}

export async function machineScmLogList(
    machineId: string,
    request: ScmLogListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmLogListResponse | ScmRpcFailure> {
    const response = await callMachineScm<ScmLogListResponse, ScmLogListRequest>(
        machineId,
        RPC_METHODS.SCM_LOG_LIST,
        request,
        options,
    );
    return ScmLogListResponseSchema.parse(response);
}

export async function machineScmHistoryEntries(
    machineId: string,
    request: ScmHistoryEntriesRequest,
    options?: MachineScmCallOptions,
): Promise<ScmHistoryEntriesResponse | ScmRpcFailure> {
    return ScmHistoryEntriesResponseSchema.parse(await callMachineScm<ScmHistoryEntriesResponse, ScmHistoryEntriesRequest>(
        machineId, RPC_METHODS.SCM_HISTORY_ENTRIES, request, options,
    ));
}

export async function machineScmCommitBackout(
    machineId: string,
    request: ScmCommitBackoutRequest,
    options?: MachineScmCallOptions,
): Promise<ScmCommitBackoutResponse | ScmRpcFailure> {
    return await callMachineScm<ScmCommitBackoutResponse, ScmCommitBackoutRequest>(machineId, RPC_METHODS.SCM_COMMIT_BACKOUT, request, options);
}

export async function machineScmRemoteFetch(
    machineId: string,
    request: ScmRemoteRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_FETCH, request, options);
}

export async function machineScmRemotePush(
    machineId: string,
    request: ScmRemoteRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_PUSH, request, options);
}

export async function machineScmRemotePull(
    machineId: string,
    request: ScmRemoteRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_PULL, request, options);
}

export async function machineScmBranchList(
    machineId: string,
    request: ScmBranchListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchListResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchListResponse, ScmBranchListRequest>(machineId, RPC_METHODS.SCM_BRANCH_LIST, request, options);
}

export async function machineScmBranchCreate(
    machineId: string,
    request: ScmBranchCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchCreateResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchCreateResponse, ScmBranchCreateRequest>(machineId, RPC_METHODS.SCM_BRANCH_CREATE, request, options);
}

export async function machineScmBranchCheckout(
    machineId: string,
    request: ScmBranchCheckoutRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchCheckoutResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchCheckoutResponse, ScmBranchCheckoutRequest>(machineId, RPC_METHODS.SCM_BRANCH_CHECKOUT, request, options);
}

export async function machineScmBranchMerge(
    machineId: string,
    request: ScmBranchIntegrationRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(machineId, RPC_METHODS.SCM_BRANCH_MERGE, request, options);
}

export async function machineScmBranchRebase(
    machineId: string,
    request: ScmBranchIntegrationRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(machineId, RPC_METHODS.SCM_BRANCH_REBASE, request, options);
}

export async function machineScmBranchOperationContinue(
    machineId: string,
    request: ScmBranchOperationControlRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(machineId, RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE, request, options);
}

export async function machineScmBranchOperationAbort(
    machineId: string,
    request: ScmBranchOperationControlRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(machineId, RPC_METHODS.SCM_BRANCH_OPERATION_ABORT, request, options);
}

export async function machineScmBranchOperationSkip(machineId: string, request: ScmBranchOperationControlRequest, options?: MachineScmCallOptions): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return callMachineScm(machineId, RPC_METHODS.SCM_BRANCH_OPERATION_SKIP, request, options);
}

export async function machineScmConflictAcceptSide(machineId: string, request: ScmConflictAcceptSideRequest, options?: MachineScmCallOptions): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return callMachineScm(machineId, RPC_METHODS.SCM_CONFLICT_ACCEPT_SIDE, request, options);
}

export async function machineScmConflictMarkResolved(machineId: string, request: ScmConflictMarkResolvedRequest, options?: MachineScmCallOptions): Promise<ScmBranchIntegrationResponse | ScmRpcFailure> {
    return callMachineScm(machineId, RPC_METHODS.SCM_CONFLICT_MARK_RESOLVED, request, options);
}

export async function machineScmWorktreeCreate(
    machineId: string,
    request: ScmWorktreeCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmWorktreeCreateResponse | ScmRpcFailure> {
    return await callMachineScm<ScmWorktreeCreateResponse, ScmWorktreeCreateRequest>(machineId, RPC_METHODS.SCM_WORKTREE_CREATE, request, options);
}

export async function machineScmWorktreeRemove(
    machineId: string,
    request: ScmWorktreeRemoveRequest,
    options?: MachineScmCallOptions,
): Promise<ScmWorktreeRemoveResponse | ScmRpcFailure> {
    return await callMachineScm<ScmWorktreeRemoveResponse, ScmWorktreeRemoveRequest>(machineId, RPC_METHODS.SCM_WORKTREE_REMOVE, request, options);
}

export async function machineScmWorktreePrune(
    machineId: string,
    request: ScmWorktreePruneRequest,
    options?: MachineScmCallOptions,
): Promise<ScmWorktreePruneResponse | ScmRpcFailure> {
    return await callMachineScm<ScmWorktreePruneResponse, ScmWorktreePruneRequest>(machineId, RPC_METHODS.SCM_WORKTREE_PRUNE, request, options);
}

export async function machineScmRemotePublish(
    machineId: string,
    request: ScmRemotePublishRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemotePublishResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemotePublishResponse, ScmRemotePublishRequest>(machineId, RPC_METHODS.SCM_REMOTE_PUBLISH, request, options);
}

export async function machineScmRemoteAdd(
    machineId: string,
    request: ScmRemoteAddRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteManagementResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemoteManagementResponse, ScmRemoteAddRequest>(machineId, RPC_METHODS.SCM_REMOTE_ADD, request, options);
}

export async function machineScmRemoteSetUrl(
    machineId: string,
    request: ScmRemoteSetUrlRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteManagementResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(machineId, RPC_METHODS.SCM_REMOTE_SET_URL, request, options);
}

export async function machineScmRemoteRemove(
    machineId: string,
    request: ScmRemoteRemoveRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteManagementResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(machineId, RPC_METHODS.SCM_REMOTE_REMOVE, request, options);
}

export async function machineScmPullRequestList(
    machineId: string,
    request: ScmPullRequestListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestListResponse | ScmRpcFailure> {
    return await callMachineScm<ScmPullRequestListResponse, ScmPullRequestListRequest>(machineId, RPC_METHODS.SCM_PULL_REQUEST_LIST, request, options);
}

export async function machineScmPullRequestGet(
    machineId: string,
    request: ScmPullRequestGetRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestGetResponse | ScmRpcFailure> {
    return await callMachineScm<ScmPullRequestGetResponse, ScmPullRequestGetRequest>(machineId, RPC_METHODS.SCM_PULL_REQUEST_GET, request, options);
}

export async function machineScmPullRequestOpenCompose(
    machineId: string,
    request: ScmPullRequestOpenComposeRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestOpenComposeResponse | ScmRpcFailure> {
    return await callMachineScm<ScmPullRequestOpenComposeResponse, ScmPullRequestOpenComposeRequest>(
        machineId,
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        request,
        options,
    );
}

export async function machineScmPullRequestOpenOrReuse(
    machineId: string,
    request: ScmPullRequestOpenOrReuseRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestOpenOrReuseResponse | ScmRpcFailure> {
    return await callMachineScm<ScmPullRequestOpenOrReuseResponse, ScmPullRequestOpenOrReuseRequest>(
        machineId,
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        request,
        options,
    );
}

export async function machineScmRepositoryInit(
    machineId: string,
    request: ScmRepositoryInitRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRepositoryInitResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRepositoryInitResponse, ScmRepositoryInitRequest>(
        machineId,
        RPC_METHODS.SCM_REPOSITORY_INIT,
        request,
        options,
    );
}

export async function machineScmHostingRepositoryDescribePublishTargets(
    machineId: string,
    request: ScmHostingRepositoryDescribePublishTargetsRequest,
    options?: MachineScmCallOptions,
): Promise<ScmHostingRepositoryDescribePublishTargetsResponse | ScmRpcFailure> {
    return await callMachineScm<ScmHostingRepositoryDescribePublishTargetsResponse, ScmHostingRepositoryDescribePublishTargetsRequest>(
        machineId,
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        request,
        options,
    );
}

export async function machineScmHostingRepositoryPublish(
    machineId: string,
    request: ScmHostingRepositoryPublishRequest,
    options?: MachineScmCallOptions,
): Promise<ScmHostingRepositoryPublishResponse | ScmRpcFailure> {
    return await callMachineScm<ScmHostingRepositoryPublishResponse, ScmHostingRepositoryPublishRequest>(
        machineId,
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        request,
        options,
    );
}

export async function machineScmRepositoryRemoveIndexLock(
    machineId: string,
    request: ScmRepositoryRemoveIndexLockRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRepositoryRemoveIndexLockResponse | ScmRpcFailure> {
    return await callMachineScm<ScmRepositoryRemoveIndexLockResponse, ScmRepositoryRemoveIndexLockRequest>(
        machineId,
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        request,
        options,
    );
}

export async function machineScmStashList(
    machineId: string,
    request: ScmStashListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashListResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStashListResponse, ScmStashListRequest>(machineId, RPC_METHODS.SCM_STASH_LIST, request, options);
}

export async function machineScmStashCreate(
    machineId: string,
    request: ScmStashCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashCreateResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStashCreateResponse, ScmStashCreateRequest>(machineId, RPC_METHODS.SCM_STASH_CREATE, request, options);
}

export async function machineScmStashDrop(
    machineId: string,
    request: ScmStashDropRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashDropResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStashDropResponse, ScmStashDropRequest>(machineId, RPC_METHODS.SCM_STASH_DROP, request, options);
}

export async function machineScmStashPop(
    machineId: string,
    request: ScmStashPopRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashPopResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStashPopResponse, ScmStashPopRequest>(machineId, RPC_METHODS.SCM_STASH_POP, request, options);
}

export async function machineScmStashApply(
    machineId: string,
    request: ScmStashApplyRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashApplyResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStashApplyResponse, ScmStashApplyRequest>(machineId, RPC_METHODS.SCM_STASH_APPLY, request, options);
}

export async function machineScmStashShow(
    machineId: string,
    request: ScmStashShowRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashShowResponse | ScmRpcFailure> {
    return await callMachineScm<ScmStashShowResponse, ScmStashShowRequest>(machineId, RPC_METHODS.SCM_STASH_SHOW, request, options);
}
