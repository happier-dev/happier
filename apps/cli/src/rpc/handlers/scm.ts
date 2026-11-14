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
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
} from '@happier-dev/protocol';
import { SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    createNonRepositoryScmSnapshotResponse,
    notRepositoryResponse,
    runScmRoute,
} from '@/scm/rpc/dispatch';
import type { ScmFilesystemAccessPolicy } from '@/scm/runtime';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';
import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';

import { registerScmPullRequestHandlers } from './scm/registerScmPullRequestHandlers';
import { registerScmRepositoryProvisioningHandlers } from './scm/registerScmRepositoryProvisioningHandlers';
import type { ScmHandlerRouteBase } from './scm/scmHandlerRouteBase';

/** Serialized bytes of the ',' between two entries of the entries array. */
const STATUS_SNAPSHOT_ENTRY_SEPARATOR_BYTES = 1;

/**
 * Bounds the entry list of a snapshot reply at the one choke point every backend's snapshot
 * passes through, so a huge working tree (e.g. an untracked build output) cannot produce a reply
 * that drops the machine socket. The backend computed totals from its full entry set; they are
 * kept, and `totals.changedFiles` records the full changed-file count before truncation. Entries
 * are cut only between whole entries, in shipped order, and the snapshot is then marked
 * `entriesPresentation: 'truncated'`. A first entry larger than the budget yields an empty prefix.
 */
function applyStatusSnapshotEntryBudget(response: ScmStatusSnapshotResponse): ScmStatusSnapshotResponse {
    const snapshot = response.success === true ? response.snapshot : undefined;
    if (!snapshot || !Array.isArray(snapshot.entries)) return response;
    const totals = { ...snapshot.totals, changedFiles: snapshot.totals.changedFiles ?? snapshot.entries.length };
    let accumulatedBytes = 0;
    let shippedCount = 0;
    for (const entry of snapshot.entries) {
        const separatorBytes = shippedCount > 0 ? STATUS_SNAPSHOT_ENTRY_SEPARATOR_BYTES : 0;
        const entryBytes = estimateJsonUtf8BytesBounded(entry, SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES);
        if (accumulatedBytes + separatorBytes + entryBytes > SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES) {
            return {
                ...response,
                snapshot: {
                    ...snapshot,
                    entries: snapshot.entries.slice(0, shippedCount),
                    entriesPresentation: 'truncated',
                    totals,
                },
            };
        }
        accumulatedBytes += separatorBytes + entryBytes;
        shippedCount += 1;
    }
    return { ...response, snapshot: { ...snapshot, totals } };
}

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
    const statusSnapshotInFlight = new Map<string, Promise<ScmStatusSnapshotResponse>>();
    const statusSnapshotCache = new Map<string, { value: ScmStatusSnapshotResponse; expiresAtMs: number }>();
    const statusSnapshotCacheTtlMs = (() => {
        const raw = (process.env.HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS ?? '').trim();
        if (!raw) return 1_000;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1_000;
    })();
    let statusSnapshotCacheGeneration = 0;
    const invalidateStatusSnapshotCache = (): void => {
        statusSnapshotCacheGeneration += 1;
        statusSnapshotCache.clear();
        statusSnapshotInFlight.clear();
    };
    const runWithStatusSnapshotCacheInvalidation = async <TResponse,>(
        run: () => Promise<TResponse>,
    ): Promise<TResponse> => {
        invalidateStatusSnapshotCache();
        try {
            return await run();
        } finally {
            invalidateStatusSnapshotCache();
        }
    };
    const statusSnapshotKey = (request: ScmStatusSnapshotRequest): string => JSON.stringify({
        cwd: request.cwd ?? null,
        backendPreference: request.backendPreference ?? null,
        includeWorktreeStatus: request.includeWorktreeStatus === true,
    });
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
        }).then((backendValue) => {
            const value = applyStatusSnapshotEntryBudget(backendValue);
            if (statusSnapshotCacheTtlMs > 0 && cacheGeneration === statusSnapshotCacheGeneration) {
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
        async (request) => runStatusSnapshot(request)
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
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmChangeApplyRequest, ScmChangeApplyResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmChangeApplyResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.changeInclude({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmChangeApplyRequest, ScmChangeApplyResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmChangeApplyResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.changeExclude({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmChangeDiscardRequest, ScmChangeDiscardResponse>(
        RPC_METHODS.SCM_CHANGE_DISCARD,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmChangeDiscardRequest, ScmChangeDiscardResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmChangeDiscardResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.changeDiscard({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmCommitCreateRequest, ScmCommitCreateResponse>(
        RPC_METHODS.SCM_COMMIT_CREATE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmCommitCreateRequest, ScmCommitCreateResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmCommitCreateResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.commitCreate({ context, request }),
                })
            )
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
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmBranchCreateRequest, ScmBranchCreateResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmBranchCreateResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.branchCreate({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>(
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmBranchCheckoutResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.branchCheckout({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_MERGE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.branchMerge({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_REBASE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.branchRebase({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.branchOperationContinue({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmBranchIntegrationResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.branchOperationAbort({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>(
        RPC_METHODS.SCM_WORKTREE_CREATE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmWorktreeCreateResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.worktreeCreate({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>(
        RPC_METHODS.SCM_WORKTREE_REMOVE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmWorktreeRemoveResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.worktreeRemove({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmWorktreePruneRequest, ScmWorktreePruneResponse>(
        RPC_METHODS.SCM_WORKTREE_PRUNE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmWorktreePruneRequest, ScmWorktreePruneResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmWorktreePruneResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.worktreePrune({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmWorktreesEnrichmentRequest, ScmWorktreesEnrichmentResponse>(
        RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
        async (request) =>
            runScmRoute<ScmWorktreesEnrichmentRequest, ScmWorktreesEnrichmentResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => ({ success: true, worktrees: [] }),
                runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreesEnrichment({ context, request }),
            })
    );

    rpcHandlerManager.registerHandler<ScmCommitBackoutRequest, ScmCommitBackoutResponse>(
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmCommitBackoutRequest, ScmCommitBackoutResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmCommitBackoutResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.commitBackout({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemoteAddRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_ADD,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemoteAddRequest, ScmRemoteManagementResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remoteAdd({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_SET_URL,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remoteSetUrl({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_REMOVE,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemoteManagementResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remoteRemove({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_FETCH,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remoteFetch({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PUSH,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remotePush({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PULL,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemoteRequest, ScmRemoteResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemoteResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remotePull({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmRemotePublishRequest, ScmRemotePublishResponse>(
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmRemotePublishRequest, ScmRemotePublishResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmRemotePublishResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.remotePublish({ context, request }),
                })
            )
    );

    registerScmRepositoryProvisioningHandlers(
        rpcHandlerManager,
        routeBase,
        runWithStatusSnapshotCacheInvalidation
    );
    registerScmPullRequestHandlers(
        rpcHandlerManager,
        routeBase,
        runWithStatusSnapshotCacheInvalidation
    );

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
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmStashDropRequest, ScmStashDropResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmStashDropResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.stashDrop({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmStashPopRequest, ScmStashPopResponse>(
        RPC_METHODS.SCM_STASH_POP,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmStashPopRequest, ScmStashPopResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmStashPopResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.stashPop({ context, request }),
                })
            )
    );

    rpcHandlerManager.registerHandler<ScmStashApplyRequest, ScmStashApplyResponse>(
        RPC_METHODS.SCM_STASH_APPLY,
        async (request) =>
            runWithStatusSnapshotCacheInvalidation(() =>
                runScmRoute<ScmStashApplyRequest, ScmStashApplyResponse>({
                    request,
                    ...routeBase,
                    onNonRepository: async () => notRepositoryResponse<ScmStashApplyResponse>(),
                    runWithBackend: ({ context, selection }) =>
                        selection.backend.stashApply({ context, request }),
                })
            )
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
