import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchOperationControlRequest,
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
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemoteRemoveRequest,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
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
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    createNonRepositoryScmSnapshotResponse,
    notRepositoryResponse,
    runScmRoute,
} from '@/scm/rpc/dispatch';
import type { ScmFilesystemAccessPolicy } from '@/scm/runtime';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';

import { registerScmPullRequestHandlers } from './scm/registerScmPullRequestHandlers';
import { registerScmRepositoryProvisioningHandlers } from './scm/registerScmRepositoryProvisioningHandlers';
import type { ScmHandlerRouteBase } from './scm/scmHandlerRouteBase';

export function registerScmHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    deps?: Readonly<{
        accessPolicy?: ScmFilesystemAccessPolicy;
        connectedAccounts?: ScmConnectedAccountCredentialResolver;
    }>
): void {
    const routeBase: ScmHandlerRouteBase = {
        workingDirectory,
        accessPolicy: deps?.accessPolicy,
        connectedAccounts: deps?.connectedAccounts,
    };

    rpcHandlerManager.registerHandler<ScmBackendDescribeRequest, ScmBackendDescribeResponse>(
        RPC_METHODS.SCM_BACKEND_DESCRIBE,
        async (request) =>
            runScmRoute<ScmBackendDescribeRequest, ScmBackendDescribeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => ({ success: true, isRepo: false }),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.describeBackend({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>(
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        async (request) =>
            runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({
                request,
                ...routeBase,
                onNonRepository: async ({ cwd }) =>
                    createNonRepositoryScmSnapshotResponse({
                        workingDirectory,
                        cwd,
                    }),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.statusSnapshot({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmDiffFileRequest, ScmDiffFileResponse>(
        RPC_METHODS.SCM_DIFF_FILE,
        async (request) =>
            runScmRoute<ScmDiffFileRequest, ScmDiffFileResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmDiffFileResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.diffFile({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmDiffCommitRequest, ScmDiffCommitResponse>(
        RPC_METHODS.SCM_DIFF_COMMIT,
        async (request) =>
            runScmRoute<ScmDiffCommitRequest, ScmDiffCommitResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmDiffCommitResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.diffCommit({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_INCLUDE,
        async (request) =>
            runScmRoute<ScmChangeApplyRequest, ScmChangeApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmChangeApplyResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.changeInclude({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        async (request) =>
            runScmRoute<ScmChangeApplyRequest, ScmChangeApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmChangeApplyResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.changeExclude({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmChangeDiscardRequest, ScmChangeDiscardResponse>(
        RPC_METHODS.SCM_CHANGE_DISCARD,
        async (request) =>
            runScmRoute<ScmChangeDiscardRequest, ScmChangeDiscardResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmChangeDiscardResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.changeDiscard({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmCommitCreateRequest, ScmCommitCreateResponse>(
        RPC_METHODS.SCM_COMMIT_CREATE,
        async (request) =>
            runScmRoute<ScmCommitCreateRequest, ScmCommitCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmCommitCreateResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.commitCreate({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmLogListRequest, ScmLogListResponse>(
        RPC_METHODS.SCM_LOG_LIST,
        async (request) =>
            runScmRoute<ScmLogListRequest, ScmLogListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmLogListResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.logList({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchListRequest, ScmBranchListResponse>(
        RPC_METHODS.SCM_BRANCH_LIST,
        async (request) =>
            runScmRoute<ScmBranchListRequest, ScmBranchListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchListResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchList({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchCreateRequest, ScmBranchCreateResponse>(
        RPC_METHODS.SCM_BRANCH_CREATE,
        async (request) =>
            runScmRoute<ScmBranchCreateRequest, ScmBranchCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchCreateResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchCreate({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>(
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        async (request) =>
            runScmRoute<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchCheckoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchCheckout({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_MERGE,
        async (request) =>
            runScmRoute<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchMerge({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_REBASE,
        async (request) =>
            runScmRoute<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchRebase({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        async (request) =>
            runScmRoute<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchOperationContinue({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
        async (request) =>
            runScmRoute<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchOperationAbort({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>(
        RPC_METHODS.SCM_WORKTREE_CREATE,
        async (request) =>
            runScmRoute<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreeCreateResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreeCreate({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>(
        RPC_METHODS.SCM_WORKTREE_REMOVE,
        async (request) =>
            runScmRoute<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreeRemoveResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreeRemove({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmWorktreePruneRequest, ScmWorktreePruneResponse>(
        RPC_METHODS.SCM_WORKTREE_PRUNE,
        async (request) =>
            runScmRoute<ScmWorktreePruneRequest, ScmWorktreePruneResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreePruneResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreePrune({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmCommitBackoutRequest, ScmCommitBackoutResponse>(
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        async (request) =>
            runScmRoute<ScmCommitBackoutRequest, ScmCommitBackoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmCommitBackoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.commitBackout({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteAddRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_ADD,
        async (request) =>
            runScmRoute<ScmRemoteAddRequest, ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteAdd({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_SET_URL,
        async (request) =>
            runScmRoute<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteSetUrl({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_REMOVE,
        async (request) =>
            runScmRoute<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteRemove({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_FETCH,
        async (request) =>
            runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteFetch({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PUSH,
        async (request) =>
            runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePush({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PULL,
        async (request) =>
            runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePull({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemotePublishRequest, ScmRemotePublishResponse>(
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        async (request) =>
            runScmRoute<ScmRemotePublishRequest, ScmRemotePublishResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemotePublishResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePublish({ context, request }),
            })
    );

    registerScmRepositoryProvisioningHandlers(rpcHandlerManager, routeBase);
    registerScmPullRequestHandlers(rpcHandlerManager, routeBase);

    rpcHandlerManager.registerHandler<ScmStashListRequest, ScmStashListResponse>(
        RPC_METHODS.SCM_STASH_LIST,
        async (request) =>
            runScmRoute<ScmStashListRequest, ScmStashListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashListResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashList({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmStashDropRequest, ScmStashDropResponse>(
        RPC_METHODS.SCM_STASH_DROP,
        async (request) =>
            runScmRoute<ScmStashDropRequest, ScmStashDropResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashDropResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashDrop({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmStashPopRequest, ScmStashPopResponse>(
        RPC_METHODS.SCM_STASH_POP,
        async (request) =>
            runScmRoute<ScmStashPopRequest, ScmStashPopResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashPopResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashPop({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmStashApplyRequest, ScmStashApplyResponse>(
        RPC_METHODS.SCM_STASH_APPLY,
        async (request) =>
            runScmRoute<ScmStashApplyRequest, ScmStashApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashApplyResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashApply({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmStashShowRequest, ScmStashShowResponse>(
        RPC_METHODS.SCM_STASH_SHOW,
        async (request) =>
            runScmRoute<ScmStashShowRequest, ScmStashShowResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashShowResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashShow({ context, request }),
            })
    );
}
