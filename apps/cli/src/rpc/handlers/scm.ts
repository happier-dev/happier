import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
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
import type { ScmCommitUndoLastRequest, ScmCommitUndoLastResponse, ScmConflictAcceptSideRequest, ScmConflictMarkResolvedRequest } from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { ScmLogListRequestSchema } from '@happier-dev/protocol/scm';
import { ScmHistoryEntriesRequestSchema, type ScmHistoryEntriesRequest, type ScmHistoryEntriesResponse } from '@happier-dev/protocol/scm/entriesHistoryV1';
import type { ScmStatusSnapshotTransportResponse } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    executeScmActionOperation,
} from '@/scm/actions/executeScmActionOperation';
import { resolveFilesystemAccessPolicy, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ResolvedScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import type { ScmHostingRepositoryResolveAddressRequestV1, ScmHostingRepositoryResolveAddressResponseV1 } from '@happier-dev/protocol/scm/repositoryClone';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { readStoredCredentials } from '@/persistence';

const scmRpcOperationContextStorage = new AsyncLocalStorage<RpcHandlerContext>();

export function registerScmHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    deps?: Readonly<{
        accessPolicy?: FilesystemAccessPolicy;
        registry?: ScmBackendRegistry;
        hostingProviderRegistry?: ResolvedScmHostingProviderRegistry;
        machineId?: string;
        actionExecutor?: RpcActionExecutor;
    }>,
): void {
    const scmRpcHandlerManager: RpcHandlerRegistrar = {
        registerHandler<TRequest = any, TResponse = any>(
            method: string,
            handler: RpcHandler<TRequest, TResponse>,
        ): void {
            rpcHandlerManager.registerHandler(method, (request, context) => {
                const operationContext = context ?? Object.freeze({ signal: new AbortController().signal });
                return (
                scmRpcOperationContextStorage.run(
                    operationContext,
                    () => handler(request, operationContext),
                )
                );
            });
        },
    };
    const routeBase = {
        workingDirectory,
        accessPolicy: deps?.accessPolicy,
        registry: deps?.registry,
        hostingProviderRegistry: deps?.hostingProviderRegistry,
        get signal(): AbortSignal | undefined {
            return scmRpcOperationContextStorage.getStore()?.signal;
        },
    } as const;
    const authorizeWorkSession = async (sessionId: string): Promise<boolean> => {
        const ingress = scmRpcOperationContextStorage.getStore();
        return ingress?.signal.aborted === false && ingress.authorization?.kind === 'session.write'
            && ingress.authorization.sessionId === sessionId;
    };
    registerActionSpecRpcHandlers({
        rpcHandlerManager: scmRpcHandlerManager,
        actionIds: ['scm.diffSummary.capture', 'scm.diffSummary.generate',
            'scm.diffSummary.result.list', 'scm.diffSummary.result.clear',
            'scm.diffSummary.result.read', 'scm.diffSummary.result.edit',
            'scm.diffSummary.result.undo', 'scm.diffSummary.result.delete',
            'scm.diffSummary.refine', 'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss',
            'scm.diffSummary.commitPlan.accept', 'scm.diffSummary.commitPlan.stop',
            'scm.diffSummary.commitPlan.includeHookChanges', 'scm.diffSummary.commitPlan.cancel',
            'scm.diffSummary.commitPlan.recover', 'scm.commit.resolveOutcome',
            'scm.diffSummary.reviewed.mark', 'scm.diffSummary.reviewed.unmark'],
        ...(deps?.machineId ? { targetMachineId: deps.machineId } : {}),
        defaultMachineTarget: true,
        ...(deps?.actionExecutor ? { actionExecutor: deps.actionExecutor } : {}),
        resolveActionExecutor: async () => {
            const credentials = await readStoredCredentials().catch(() => null);
            if (!credentials) return {
                execute: async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' }),
            };
            const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
            return createCliActionExecutorFromCredentials({
                credentials,
                scmFilesystemAccessPolicy: deps?.accessPolicy ?? resolveFilesystemAccessPolicy(),
                readCredentials: async () => await readStoredCredentials().catch(() => null),
                sessionLogAccess: { workingDirectory, accessPolicy: deps?.accessPolicy ?? resolveFilesystemAccessPolicy() },
            });
        },
    });
    const statusSnapshotInFlight = new Map<string, Promise<ScmStatusSnapshotTransportResponse>>();
    const statusSnapshotCache = new Map<string, { value: ScmStatusSnapshotTransportResponse; expiresAtMs: number }>();
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
        operationStateVersion: request.operationStateVersion ?? null,
        outcomeVersion: request.outcomeVersion ?? null,
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
    const runStatusSnapshot = (request: ScmStatusSnapshotRequest): Promise<ScmStatusSnapshotTransportResponse> => {
        const key = statusSnapshotKey(request);
        const cached = statusSnapshotCache.get(key);
        if (cached && cached.expiresAtMs > Date.now()) {
            return Promise.resolve(cached.value);
        }
        const existing = statusSnapshotInFlight.get(key);
        if (existing) return existing;
        const cacheGeneration = statusSnapshotCacheGeneration;
        const promise = executeScmActionOperation({
            actionId: 'scm.status.snapshot',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }).then((result) => {
            const response = result as ScmStatusSnapshotResponse;
            // Omit neutral facts once, before shared in-flight/cache publication.
            // Keep the existing schema's input shape; there is no separate wire codec.
            const value: ScmStatusSnapshotTransportResponse = response.snapshot && response.snapshot.entries.length > 0 ? {
                ...response,
                snapshot: {
                    ...response.snapshot,
                    entries: response.snapshot.entries.map((entry) => ({
                        path: entry.path,
                        kind: entry.kind,
                        includeStatus: entry.includeStatus,
                        pendingStatus: entry.pendingStatus,
                        previousPath: entry.previousPath === null ? undefined : entry.previousPath,
                        hasIncludedDelta: entry.hasIncludedDelta || undefined,
                        hasPendingDelta: entry.hasPendingDelta || undefined,
                        stats: {
                            includedAdded: entry.stats.includedAdded || undefined,
                            includedRemoved: entry.stats.includedRemoved || undefined,
                            pendingAdded: entry.stats.pendingAdded || undefined,
                            pendingRemoved: entry.stats.pendingRemoved || undefined,
                            isBinary: entry.stats.isBinary || undefined,
                            isComplete: entry.stats.isComplete,
                        },
                    })),
                },
            } : response;
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
        async (request) => await executeScmActionOperation({
            actionId: 'scm.backend.describe',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmBackendDescribeResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStatusSnapshotRequest, ScmStatusSnapshotTransportResponse>(
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        async (request) => runStatusSnapshot(request)
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreesEnrichmentRequest, ScmWorktreesEnrichmentResponse>(
        RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktrees.enrichment',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmWorktreesEnrichmentResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmDiffFileRequest, ScmDiffFileResponse>(
        RPC_METHODS.SCM_DIFF_FILE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.diff.file',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmDiffFileResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmDiffCommitRequest, ScmDiffCommitResponse>(
        RPC_METHODS.SCM_DIFF_COMMIT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.diff.commit',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmDiffCommitResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_INCLUDE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.change.include',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmChangeApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmChangeApplyRequest, ScmChangeApplyResponse>(
        RPC_METHODS.SCM_CHANGE_EXCLUDE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.change.exclude',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmChangeApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmChangeDiscardRequest, ScmChangeDiscardResponse>(
        RPC_METHODS.SCM_CHANGE_DISCARD,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.change.discard',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmChangeDiscardResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmCommitCreateRequest, ScmCommitCreateResponse>(
        RPC_METHODS.SCM_COMMIT_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.commit.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmCommitCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmLogListRequest, ScmLogListResponse>(
        RPC_METHODS.SCM_LOG_LIST,
        async (request) => {
            const parsed = ScmLogListRequestSchema.safeParse(request);
            if (!parsed.success) {
                return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid SCM log-list request' };
            }
            return await executeScmActionOperation({
                actionId: 'scm.log.list',
                input: parsed.data,
                ...routeBase,
                rpcCompatibility: true,
            }) as ScmLogListResponse;
        },
    );

    scmRpcHandlerManager.registerHandler<ScmHistoryEntriesRequest, ScmHistoryEntriesResponse>(
        RPC_METHODS.SCM_HISTORY_ENTRIES,
        async request => {
            const parsed = ScmHistoryEntriesRequestSchema.safeParse(request);
            if (!parsed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid SCM entry-history request' };
            // This new wire operation has no predecessor reader. Preserve its closed
            // result and typed witness errors rather than applying released-read projection.
            return await executeScmActionOperation({ actionId: 'scm.history.entries', input: parsed.data,
                ...routeBase }) as ScmHistoryEntriesResponse;
        },
    );

    scmRpcHandlerManager.registerHandler<ScmBranchListRequest, ScmBranchListResponse>(
        RPC_METHODS.SCM_BRANCH_LIST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.list',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
        }) as ScmBranchListResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchCreateRequest, ScmBranchCreateResponse>(
        RPC_METHODS.SCM_BRANCH_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchCheckoutRequest, ScmBranchCheckoutResponse>(
        RPC_METHODS.SCM_BRANCH_CHECKOUT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.checkout',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchCheckoutResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_MERGE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.merge',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchIntegrationRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_REBASE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.rebase',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.operation.continue',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.operation.abort',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmBranchOperationControlRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_BRANCH_OPERATION_SKIP,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.branch.operation.skip',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmConflictAcceptSideRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_CONFLICT_ACCEPT_SIDE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.conflict.acceptSide',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmConflictMarkResolvedRequest, ScmBranchIntegrationResponse>(
        RPC_METHODS.SCM_CONFLICT_MARK_RESOLVED,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.conflict.markResolved',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmBranchIntegrationResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>(
        RPC_METHODS.SCM_WORKTREE_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktree.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmWorktreeCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>(
        RPC_METHODS.SCM_WORKTREE_REMOVE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktree.remove',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmWorktreeRemoveResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmWorktreePruneRequest, ScmWorktreePruneResponse>(
        RPC_METHODS.SCM_WORKTREE_PRUNE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.worktree.prune',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmWorktreePruneResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmCommitBackoutRequest, ScmCommitBackoutResponse>(
        RPC_METHODS.SCM_COMMIT_BACKOUT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.commit.backout',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmCommitBackoutResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmCommitUndoLastRequest, ScmCommitUndoLastResponse>(
        RPC_METHODS.SCM_COMMIT_UNDO_LAST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.commit.undoLast',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmCommitUndoLastResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteAddRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_ADD,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.add',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteManagementResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteSetUrlRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_SET_URL,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.setUrl',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteManagementResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRemoveRequest, ScmRemoteManagementResponse>(
        RPC_METHODS.SCM_REMOTE_REMOVE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.remove',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteManagementResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_FETCH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.fetch',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PUSH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.push',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemoteRequest, ScmRemoteResponse>(
        RPC_METHODS.SCM_REMOTE_PULL,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.pull',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemoteResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRemotePublishRequest, ScmRemotePublishResponse>(
        RPC_METHODS.SCM_REMOTE_PUBLISH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.remote.publish',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRemotePublishResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestListRequest, ScmPullRequestListResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_LIST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.list',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
        }) as ScmPullRequestListResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestGetRequest, ScmPullRequestGetResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_GET,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.get',
            input: request,
            ...routeBase,
            authorizeSession: authorizeWorkSession,
            rpcCompatibility: true,
        }) as ScmPullRequestGetResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.openCompose',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmPullRequestOpenComposeResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.openOrReuse',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestOpenOrReuseResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.checkout',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestCheckoutResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.prepareWorktree',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestPrepareWorktreeResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>(
        RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.pullRequest.runStacked',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmPullRequestRunStackedResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryInitRequest, ScmRepositoryInitResponse>(
        RPC_METHODS.SCM_REPOSITORY_INIT,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.repository.init',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRepositoryInitResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryCloneInput, ScmRepositoryCloneOutput>(
        RPC_METHODS.SCM_REPOSITORY_CLONE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.repository.clone',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRepositoryCloneOutput,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryResolveAddressRequestV1, ScmHostingRepositoryResolveAddressResponseV1>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_RESOLVE_ADDRESS,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.resolveAddress', input: request, ...routeBase,
        }) as ScmHostingRepositoryResolveAddressResponseV1,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.describePublishTargets',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmHostingRepositoryDescribePublishTargetsResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>(
        RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.hostingRepository.publish',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmHostingRepositoryPublishResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>(
        RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.repository.removeIndexLock',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmRepositoryRemoveIndexLockResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashListRequest, ScmStashListResponse>(
        RPC_METHODS.SCM_STASH_LIST,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.list',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmStashListResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashDropRequest, ScmStashDropResponse>(
        RPC_METHODS.SCM_STASH_DROP,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.drop',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashDropResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashCreateRequest, ScmStashCreateResponse>(
        RPC_METHODS.SCM_STASH_CREATE,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.create',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashCreateResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashPopRequest, ScmStashPopResponse>(
        RPC_METHODS.SCM_STASH_POP,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.pop',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashPopResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashApplyRequest, ScmStashApplyResponse>(
        RPC_METHODS.SCM_STASH_APPLY,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.apply',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
            runMutation: runWithStatusSnapshotCacheInvalidation,
        }) as ScmStashApplyResponse,
    );

    scmRpcHandlerManager.registerHandler<ScmStashShowRequest, ScmStashShowResponse>(
        RPC_METHODS.SCM_STASH_SHOW,
        async (request) => await executeScmActionOperation({
            actionId: 'scm.stash.show',
            input: request,
            ...routeBase,
            rpcCompatibility: true,
        }) as ScmStashShowResponse,
    );
}
