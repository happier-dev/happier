import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
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
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    createNonRepositoryScmSnapshotResponse,
    notRepositoryResponse,
    runScmRoute,
} from '@/scm/rpc/dispatch';

export function registerScmHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
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
}
