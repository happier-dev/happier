import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBackendPreference,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
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
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmRemoteSetUrlRequest,
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmPullRequestCheckoutRequest,
    ScmPullRequestCheckoutResponse,
    ScmPullRequestPrepareWorktreeRequest,
    ScmPullRequestPrepareWorktreeResponse,
    ScmPullRequestRunStackedRequest,
    ScmPullRequestRunStackedResponse,
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmRepositoryCloneInput,
    ScmRepositoryCloneOutput,
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
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    createNonRepositoryScmSnapshotResponse,
    notRepositoryResponse,
    runScmRoute,
} from '@/scm/rpc/dispatch';
import {
    runScmHostingRepositoryDescribePublishTargetsRoute,
    runScmHostingRepositoryPublishRoute,
    runScmRepositoryCloneRoute,
    runScmRepositoryInitRoute,
    runScmRepositoryRemoveIndexLockRoute,
} from '@/scm/rpc/repositoryProvisioningDispatch';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

type MutatingScmRouteRequest = {
    cwd?: string;
    backendPreference?: ScmBackendPreference;
};

type MutatingScmRouteResponse = {
    success: boolean;
    error?: string;
    errorCode?: string;
};

const scmRpcOperationSignalStorage = new AsyncLocalStorage<AbortSignal>();

export function registerScmHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    deps?: Readonly<{ accessPolicy?: FilesystemAccessPolicy }>,
): void {
    const scmRpcHandlerManager: RpcHandlerRegistrar = {
        registerHandler<TRequest = any, TResponse = any>(
            method: string,
            handler: RpcHandler<TRequest, TResponse>,
        ): void {
            rpcHandlerManager.registerHandler(method, (request, context) => {
                const operationContext = context ?? Object.freeze({ signal: new AbortController().signal });
                return (
                scmRpcOperationSignalStorage.run(
                    operationContext.signal,
                    () => handler(request, operationContext),
                )
                );
            });
        },
    };
    const routeBase = {
        workingDirectory,
        accessPolicy: deps?.accessPolicy,
        get signal(): AbortSignal | undefined {
            return scmRpcOperationSignalStorage.getStore();
        },
    } as const;
    const statusSnapshotInFlight = new Map<string, Promise<ScmStatusSnapshotResponse>>();
    const statusSnapshotCache = new Map<string, { value: ScmStatusSnapshotResponse; expiresAtMs: number }>();
    let statusSnapshotCacheGeneration = 0;
    const statusSnapshotCacheTtlMs = (() => {
        const raw = (process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS ?? '').trim();
        if (!raw) return 1_000;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1_000;
    })();
    const statusSnapshotKey = (request: ScmStatusSnapshotRequest): string => JSON.stringify({
        cwd: request.cwd ?? null,
        backendPreference: request.backendPreference ?? null,
        includeWorktreeStatus: request.includeWorktreeStatus === true,
    });
    const invalidateStatusSnapshotCache = (): void => {
        statusSnapshotCacheGeneration += 1;
        statusSnapshotInFlight.clear();
        statusSnapshotCache.clear();
    };
    const runWithStatusSnapshotCacheInvalidation = async <T>(operation: () => Promise<T>): Promise<T> => {
        invalidateStatusSnapshotCache();
        try {
            return await operation();
        } finally {
            invalidateStatusSnapshotCache();
        }
    };
    const runMutatingScmRoute = <TRequest extends MutatingScmRouteRequest, TResponse extends MutatingScmRouteResponse>(
        input: Parameters<typeof runScmRoute<TRequest, TResponse>>[0],
    ): Promise<TResponse> =>
        runWithStatusSnapshotCacheInvalidation(() => runScmRoute<TRequest, TResponse>(input));
    const runStatusSnapshot = (request: ScmStatusSnapshotRequest): Promise<ScmStatusSnapshotResponse> => {
        const key = statusSnapshotKey(request);
        const cached = statusSnapshotCache.get(key);
        if (cached && cached.expiresAtMs > Date.now()) {
            return Promise.resolve(cached.value);
        }
        const existing = statusSnapshotInFlight.get(key);
        if (existing) return existing;
        const cacheGeneration = statusSnapshotCacheGeneration;
        const promise = runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({
            request,
            ...routeBase,
            onNonRepository: async ({ cwd }) =>
                createNonRepositoryScmSnapshotResponse({
                    workingDirectory,
                    cwd,
                }),
            runWithBackend: ({ context, selection }) =>
                selection.backend.statusSnapshot({ context, request }),
        }).then((value) => {
            if (statusSnapshotCacheTtlMs > 0 && statusSnapshotCacheGeneration === cacheGeneration) {
                statusSnapshotCache.set(key, { value, expiresAtMs: Date.now() + statusSnapshotCacheTtlMs });
            }
            return value;
        });
        statusSnapshotInFlight.set(key, promise);
        void promise.finally(() => {
            if (statusSnapshotInFlight.get(key) === promise) {
                statusSnapshotInFlight.delete(key);
            }
        });
        return promise;
    };

    scmRpcHandlerManager.registerHandler<ScmBackendDescribeRequest, ScmBackendDescribeResponse>(
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

    scmRpcHandlerManager.registerHandler<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>(
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        async (request) => runStatusSnapshot(request)
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreesEnrichmentRequest, ScmWorktreesEnrichmentResponse>(
        RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
        async (request) =>
            runScmRoute<ScmWorktreesEnrichmentRequest, ScmWorktreesEnrichmentResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreesEnrichmentResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const handler = selection.backend.worktreesEnrichment;
                    if (!handler) {
                        return {
                            success: false,
                            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                            error: 'SCM backend operation is not implemented by this backend',
                        };
                    }
                    return handler({ context, request });
                },
            })
    );

    scmRpcHandlerManager.registerHandler<ScmDiffFileRequest, ScmDiffFileResponse>(
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

    scmRpcHandlerManager.registerHandler<ScmDiffCommitRequest, ScmDiffCommitResponse>(
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

    scmRpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_INCLUDE,
        async (request) =>
            runMutatingScmRoute<ScmChangeApplyRequest, ScmChangeApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmChangeApplyResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.changeInclude({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        async (request) =>
            runMutatingScmRoute<ScmChangeApplyRequest, ScmChangeApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmChangeApplyResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.changeExclude({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmChangeDiscardRequest, ScmChangeDiscardResponse>(
        RPC_METHODS.SCM_CHANGE_DISCARD,
        async (request) =>
            runMutatingScmRoute<ScmChangeDiscardRequest, ScmChangeDiscardResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmChangeDiscardResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.changeDiscard({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmCommitCreateRequest, ScmCommitCreateResponse>(
        RPC_METHODS.SCM_COMMIT_CREATE,
        async (request) =>
            runMutatingScmRoute<ScmCommitCreateRequest, ScmCommitCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmCommitCreateResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.commitCreate({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmLogListRequest, ScmLogListResponse>(
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

    scmRpcHandlerManager.registerHandler<ScmBranchListRequest, ScmBranchListResponse>(
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

    scmRpcHandlerManager.registerHandler<ScmBranchCreateRequest, ScmBranchCreateResponse>(
        RPC_METHODS.SCM_BRANCH_CREATE,
        async (request) =>
            runMutatingScmRoute<ScmBranchCreateRequest, ScmBranchCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchCreateResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchCreate({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>(
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        async (request) =>
            runMutatingScmRoute<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchCheckoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchCheckout({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_MERGE,
        async (request) =>
            runMutatingScmRoute<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchMerge({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_REBASE,
        async (request) =>
            runMutatingScmRoute<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchRebase({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        async (request) =>
            runMutatingScmRoute<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchOperationContinue({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
        async (request) =>
            runMutatingScmRoute<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.branchOperationAbort({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>(
        RPC_METHODS.SCM_WORKTREE_CREATE,
        async (request) =>
            runMutatingScmRoute<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreeCreateResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreeCreate({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>(
        RPC_METHODS.SCM_WORKTREE_REMOVE,
        async (request) =>
            runMutatingScmRoute<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreeRemoveResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreeRemove({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreePruneRequest, ScmWorktreePruneResponse>(
        RPC_METHODS.SCM_WORKTREE_PRUNE,
        async (request) =>
            runMutatingScmRoute<ScmWorktreePruneRequest, ScmWorktreePruneResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmWorktreePruneResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreePrune({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmCommitBackoutRequest, ScmCommitBackoutResponse>(
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        async (request) =>
            runMutatingScmRoute<ScmCommitBackoutRequest, ScmCommitBackoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmCommitBackoutResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.commitBackout({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteAddRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_ADD,
        async (request) =>
            runMutatingScmRoute<ScmRemoteAddRequest, ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteAdd({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_SET_URL,
        async (request) =>
            runMutatingScmRoute<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteSetUrl({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_REMOVE,
        async (request) =>
            runMutatingScmRoute<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteRemove({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_FETCH,
        async (request) =>
            runMutatingScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remoteFetch({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PUSH,
        async (request) =>
            runMutatingScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePush({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PULL,
        async (request) =>
            runMutatingScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePull({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRemotePublishRequest, ScmRemotePublishResponse>(
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        async (request) =>
            runMutatingScmRoute<ScmRemotePublishRequest, ScmRemotePublishResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmRemotePublishResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.remotePublish({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestListRequest, ScmPullRequestListResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_LIST,
        async (request) =>
            runScmRoute<ScmPullRequestListRequest, ScmPullRequestListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestListResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestList
                        ? selection.backend.pullRequestList({ context, request })
                        : notRepositoryResponse<ScmPullRequestListResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestGetRequest, ScmPullRequestGetResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_GET,
        async (request) =>
            runScmRoute<ScmPullRequestGetRequest, ScmPullRequestGetResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestGetResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestGet
                        ? selection.backend.pullRequestGet({ context, request })
                        : notRepositoryResponse<ScmPullRequestGetResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        async (request) =>
            runScmRoute<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestOpenCompose
                        ? selection.backend.pullRequestOpenCompose({ context, request })
                        : notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        async (request) =>
            runMutatingScmRoute<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestOpenOrReuse
                        ? selection.backend.pullRequestOpenOrReuse({ context, request })
                        : notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
        async (request) =>
            runMutatingScmRoute<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestCheckout
                        ? selection.backend.pullRequestCheckout({ context, request })
                        : notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
        async (request) =>
            runMutatingScmRoute<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestPrepareWorktree
                        ? selection.backend.pullRequestPrepareWorktree({ context, request })
                        : notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
        async (request) =>
            runMutatingScmRoute<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
                runWithBackend: async ({ context, selection }) =>
                    selection.backend.pullRequestRunStacked
                        ? selection.backend.pullRequestRunStacked({ context, request })
                        : notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryInitRequest, ScmRepositoryInitResponse>(
        RPC_METHODS.SCM_REPOSITORY_INIT,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRepositoryInitRoute({
                    request,
                    ...routeBase,
                }),
            )
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryCloneInput, ScmRepositoryCloneOutput>(
        RPC_METHODS.SCM_REPOSITORY_CLONE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRepositoryCloneRoute({
                    request,
                    ...routeBase,
                }),
            )
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        async (request) =>
            runScmHostingRepositoryDescribePublishTargetsRoute({
                request,
                ...routeBase,
            })
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmHostingRepositoryPublishRoute({
                    request,
                    ...routeBase,
                }),
            )
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>(
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRepositoryRemoveIndexLockRoute({
                    request,
                    ...routeBase,
                }),
            )
    );

    scmRpcHandlerManager.registerHandler<ScmStashListRequest, ScmStashListResponse>(
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

    scmRpcHandlerManager.registerHandler<ScmStashDropRequest, ScmStashDropResponse>(
        RPC_METHODS.SCM_STASH_DROP,
        async (request) =>
            runMutatingScmRoute<ScmStashDropRequest, ScmStashDropResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashDropResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashDrop({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmStashPopRequest, ScmStashPopResponse>(
        RPC_METHODS.SCM_STASH_POP,
        async (request) =>
            runMutatingScmRoute<ScmStashPopRequest, ScmStashPopResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashPopResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashPop({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmStashApplyRequest, ScmStashApplyResponse>(
        RPC_METHODS.SCM_STASH_APPLY,
        async (request) =>
            runMutatingScmRoute<ScmStashApplyRequest, ScmStashApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmStashApplyResponse>(),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.stashApply({ context, request }),
            })
    );

    scmRpcHandlerManager.registerHandler<ScmStashShowRequest, ScmStashShowResponse>(
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
