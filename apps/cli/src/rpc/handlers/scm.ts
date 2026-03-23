import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
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
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    createNonRepositoryScmSnapshotResponse,
    notRepositoryResponse,
    runScmRoute,
} from '@/scm/rpc/dispatch';

export function registerScmHandlers(rpcHandlerManager: RpcHandlerRegistrar, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ScmBackendDescribeRequest, ScmBackendDescribeResponse>(
        RPC_METHODS.SCM_BACKEND_DESCRIBE,
        async (request) =>
            runScmRoute<ScmBackendDescribeRequest, ScmBackendDescribeResponse>({
                request,
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
                onNonRepository: async () => notRepositoryResponse<ScmBranchCheckoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchCheckout({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>(
        RPC_METHODS.SCM_WORKTREE_CREATE,
        async (request) =>
            runScmRoute<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>({
                request,
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
                onNonRepository: async () => notRepositoryResponse<ScmCommitBackoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.commitBackout({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_FETCH,
        async (request) =>
            runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
                onNonRepository: async () => notRepositoryResponse<ScmRemotePublishResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePublish({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmStashListRequest, ScmStashListResponse>(
        RPC_METHODS.SCM_STASH_LIST,
        async (request) =>
            runScmRoute<ScmStashListRequest, ScmStashListResponse>({
                request,
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
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
                workingDirectory,
                onNonRepository: async () => notRepositoryResponse<ScmStashShowResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashShow({ context, request }),
            })
    );
}
