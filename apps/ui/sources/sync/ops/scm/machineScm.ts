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
import {
    normalizeScmGitRepoPreferredBackend,
    resolveScmGitRepoPreferredBackendId,
} from '@/scm/settings/preferences';
import { getFirstPartyScmBackendLegacyLocalId } from '@/scm/registry/firstPartyScmBackendIdentity';

const SCM_UNSUPPORTED_RESPONSE_ERROR = 'SCM_UNSUPPORTED_RESPONSE_ERROR';
const SCM_DIFF_COMMIT_TIMEOUT_MS = 120_000;

export type MachineScmCallOptions = Readonly<{ serverId?: string | null }>;

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
    // Everything reaching here threw out of the machine RPC, which means no answer came back at
    // all: the transport failed, timed out, or the machine is unreachable. No source-control
    // command ran, so `COMMAND_FAILED` was the wrong domain and its raw `error.message` put an
    // internal exception (`Cannot read properties of undefined (reading 'emit')`) into the user
    // error slot. A well-formed git failure never lands here — `assertScmResponse` returns it as a
    // `{ success: false, error, errorCode }` response without throwing. This is the same
    // classification the no-machine-target path already makes (`sessionScm.ts:81-86`), and the same
    // discipline the local-services inventory adapter applies to its own catch: a typed reason, and
    // the exception text never reaches the surface.
    return {
        success: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
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
    R extends { cwd?: string; backendPreference?: unknown }
>(
    machineId: string,
    method: string,
    request: R,
    options?: MachineScmCallOptions,
): Promise<T> {
    const payload = withScmBackendPreference(request);
    const timeoutMs = resolveScmRpcTimeoutMs(method);
    const response = await machineRpcWithServerScope<T, R>({
        machineId,
        method,
        payload: payload as R,
        ...(options?.serverId ? { serverId: options.serverId } : {}),
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
    options?: MachineScmCallOptions,
): Promise<T> {
    try {
        return await runMachineScmRpc<T, R>(machineId, method, request, options);
    } catch (error) {
        return scmFallbackError<T>(error);
    }
}

export async function machineScmStatusSnapshot(
    machineId: string,
    request: ScmStatusSnapshotRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStatusSnapshotResponse> {
    return await callMachineScm<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(machineId, RPC_METHODS.SCM_STATUS_SNAPSHOT, request, options);
}

export async function machineScmDiffFile(
    machineId: string,
    request: ScmDiffFileRequest,
    options?: MachineScmCallOptions,
): Promise<ScmDiffFileResponse> {
    return await callMachineScm<ScmDiffFileResponse, ScmDiffFileRequest>(machineId, RPC_METHODS.SCM_DIFF_FILE, request, options);
}

export async function machineScmDiffCommit(
    machineId: string,
    request: ScmDiffCommitRequest,
    options?: MachineScmCallOptions,
): Promise<ScmDiffCommitResponse> {
    return await callMachineScm<ScmDiffCommitResponse, ScmDiffCommitRequest>(machineId, RPC_METHODS.SCM_DIFF_COMMIT, request, options);
}

export async function machineScmChangeInclude(
    machineId: string,
    request: ScmChangeApplyRequest,
    options?: MachineScmCallOptions,
): Promise<ScmChangeApplyResponse> {
    return await callMachineScm<ScmChangeApplyResponse, ScmChangeApplyRequest>(machineId, RPC_METHODS.SCM_CHANGE_INCLUDE, request, options);
}

export async function machineScmChangeExclude(
    machineId: string,
    request: ScmChangeApplyRequest,
    options?: MachineScmCallOptions,
): Promise<ScmChangeApplyResponse> {
    return await callMachineScm<ScmChangeApplyResponse, ScmChangeApplyRequest>(machineId, RPC_METHODS.SCM_CHANGE_EXCLUDE, request, options);
}

export async function machineScmChangeDiscard(
    machineId: string,
    request: ScmChangeDiscardRequest,
    options?: MachineScmCallOptions,
): Promise<ScmChangeDiscardResponse> {
    return await callMachineScm<ScmChangeDiscardResponse, ScmChangeDiscardRequest>(machineId, RPC_METHODS.SCM_CHANGE_DISCARD, request, options);
}

export async function machineScmCommitCreate(
    machineId: string,
    request: ScmCommitCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmCommitCreateResponse> {
    return await callMachineScm<ScmCommitCreateResponse, ScmCommitCreateRequest>(machineId, RPC_METHODS.SCM_COMMIT_CREATE, request, options);
}

export async function machineScmLogList(
    machineId: string,
    request: ScmLogListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmLogListResponse> {
    return await callMachineScm<ScmLogListResponse, ScmLogListRequest>(machineId, RPC_METHODS.SCM_LOG_LIST, request, options);
}

export async function machineScmCommitBackout(
    machineId: string,
    request: ScmCommitBackoutRequest,
    options?: MachineScmCallOptions,
): Promise<ScmCommitBackoutResponse> {
    return await callMachineScm<ScmCommitBackoutResponse, ScmCommitBackoutRequest>(machineId, RPC_METHODS.SCM_COMMIT_BACKOUT, request, options);
}

export async function machineScmRemoteFetch(
    machineId: string,
    request: ScmRemoteRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteResponse> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_FETCH, request, options);
}

export async function machineScmRemotePush(
    machineId: string,
    request: ScmRemoteRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteResponse> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_PUSH, request, options);
}

export async function machineScmRemotePull(
    machineId: string,
    request: ScmRemoteRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteResponse> {
    return await callMachineScm<ScmRemoteResponse, ScmRemoteRequest>(machineId, RPC_METHODS.SCM_REMOTE_PULL, request, options);
}

export async function machineScmBranchList(
    machineId: string,
    request: ScmBranchListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchListResponse> {
    return await callMachineScm<ScmBranchListResponse, ScmBranchListRequest>(machineId, RPC_METHODS.SCM_BRANCH_LIST, request, options);
}

export async function machineScmBranchCreate(
    machineId: string,
    request: ScmBranchCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchCreateResponse> {
    return await callMachineScm<ScmBranchCreateResponse, ScmBranchCreateRequest>(machineId, RPC_METHODS.SCM_BRANCH_CREATE, request, options);
}

export async function machineScmBranchCheckout(
    machineId: string,
    request: ScmBranchCheckoutRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchCheckoutResponse> {
    return await callMachineScm<ScmBranchCheckoutResponse, ScmBranchCheckoutRequest>(machineId, RPC_METHODS.SCM_BRANCH_CHECKOUT, request, options);
}

export async function machineScmBranchMerge(
    machineId: string,
    request: ScmBranchIntegrationRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(machineId, RPC_METHODS.SCM_BRANCH_MERGE, request, options);
}

export async function machineScmBranchRebase(
    machineId: string,
    request: ScmBranchIntegrationRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(machineId, RPC_METHODS.SCM_BRANCH_REBASE, request, options);
}

export async function machineScmBranchOperationContinue(
    machineId: string,
    request: ScmBranchOperationControlRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(machineId, RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE, request, options);
}

export async function machineScmBranchOperationAbort(
    machineId: string,
    request: ScmBranchOperationControlRequest,
    options?: MachineScmCallOptions,
): Promise<ScmBranchIntegrationResponse> {
    return await callMachineScm<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(machineId, RPC_METHODS.SCM_BRANCH_OPERATION_ABORT, request, options);
}

export async function machineScmWorktreeCreate(
    machineId: string,
    request: ScmWorktreeCreateRequest,
    options?: MachineScmCallOptions,
): Promise<ScmWorktreeCreateResponse> {
    return await callMachineScm<ScmWorktreeCreateResponse, ScmWorktreeCreateRequest>(machineId, RPC_METHODS.SCM_WORKTREE_CREATE, request, options);
}

export async function machineScmWorktreeRemove(
    machineId: string,
    request: ScmWorktreeRemoveRequest,
    options?: MachineScmCallOptions,
): Promise<ScmWorktreeRemoveResponse> {
    return await callMachineScm<ScmWorktreeRemoveResponse, ScmWorktreeRemoveRequest>(machineId, RPC_METHODS.SCM_WORKTREE_REMOVE, request, options);
}

export async function machineScmWorktreePrune(
    machineId: string,
    request: ScmWorktreePruneRequest,
    options?: MachineScmCallOptions,
): Promise<ScmWorktreePruneResponse> {
    return await callMachineScm<ScmWorktreePruneResponse, ScmWorktreePruneRequest>(machineId, RPC_METHODS.SCM_WORKTREE_PRUNE, request, options);
}

export async function machineScmRemotePublish(
    machineId: string,
    request: ScmRemotePublishRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemotePublishResponse> {
    return await callMachineScm<ScmRemotePublishResponse, ScmRemotePublishRequest>(machineId, RPC_METHODS.SCM_REMOTE_PUBLISH, request, options);
}

export async function machineScmRemoteAdd(
    machineId: string,
    request: ScmRemoteAddRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteManagementResponse> {
    return await callMachineScm<ScmRemoteManagementResponse, ScmRemoteAddRequest>(machineId, RPC_METHODS.SCM_REMOTE_ADD, request, options);
}

export async function machineScmRemoteSetUrl(
    machineId: string,
    request: ScmRemoteSetUrlRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteManagementResponse> {
    return await callMachineScm<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(machineId, RPC_METHODS.SCM_REMOTE_SET_URL, request, options);
}

export async function machineScmRemoteRemove(
    machineId: string,
    request: ScmRemoteRemoveRequest,
    options?: MachineScmCallOptions,
): Promise<ScmRemoteManagementResponse> {
    return await callMachineScm<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(machineId, RPC_METHODS.SCM_REMOTE_REMOVE, request, options);
}

export async function machineScmPullRequestList(
    machineId: string,
    request: ScmPullRequestListRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestListResponse> {
    return await callMachineScm<ScmPullRequestListResponse, ScmPullRequestListRequest>(machineId, RPC_METHODS.SCM_PULL_REQUEST_LIST, request, options);
}

export async function machineScmPullRequestGet(
    machineId: string,
    request: ScmPullRequestGetRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestGetResponse> {
    return await callMachineScm<ScmPullRequestGetResponse, ScmPullRequestGetRequest>(machineId, RPC_METHODS.SCM_PULL_REQUEST_GET, request, options);
}

export async function machineScmPullRequestOpenCompose(
    machineId: string,
    request: ScmPullRequestOpenComposeRequest,
    options?: MachineScmCallOptions,
): Promise<ScmPullRequestOpenComposeResponse> {
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
): Promise<ScmPullRequestOpenOrReuseResponse> {
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
): Promise<ScmRepositoryInitResponse> {
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
): Promise<ScmHostingRepositoryDescribePublishTargetsResponse> {
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
): Promise<ScmHostingRepositoryPublishResponse> {
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
): Promise<ScmRepositoryRemoveIndexLockResponse> {
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
): Promise<ScmStashListResponse> {
    return await callMachineScm<ScmStashListResponse, ScmStashListRequest>(machineId, RPC_METHODS.SCM_STASH_LIST, request, options);
}

export async function machineScmStashDrop(
    machineId: string,
    request: ScmStashDropRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashDropResponse> {
    return await callMachineScm<ScmStashDropResponse, ScmStashDropRequest>(machineId, RPC_METHODS.SCM_STASH_DROP, request, options);
}

export async function machineScmStashPop(
    machineId: string,
    request: ScmStashPopRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashPopResponse> {
    return await callMachineScm<ScmStashPopResponse, ScmStashPopRequest>(machineId, RPC_METHODS.SCM_STASH_POP, request, options);
}

export async function machineScmStashApply(
    machineId: string,
    request: ScmStashApplyRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashApplyResponse> {
    return await callMachineScm<ScmStashApplyResponse, ScmStashApplyRequest>(machineId, RPC_METHODS.SCM_STASH_APPLY, request, options);
}

export async function machineScmStashShow(
    machineId: string,
    request: ScmStashShowRequest,
    options?: MachineScmCallOptions,
): Promise<ScmStashShowResponse> {
    return await callMachineScm<ScmStashShowResponse, ScmStashShowRequest>(machineId, RPC_METHODS.SCM_STASH_SHOW, request, options);
}
