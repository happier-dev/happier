import {
  SCM_OPERATION_ERROR_CODES,
  type ScmHostingProviderRef,
  type ScmOperationErrorCode,
  type ScmPullRequestOpenOrReuseRequest,
  type ScmPullRequestOpenOrReuseResponse,
  type ScmPullRequestReference,
  type ScmPullRequestState,
  type ScmPullRequestSummary,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
    readCurrentScmHostingProviderRuntimeServices,
    type ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';

import type { ScmBackendContext } from '../types.js';
import { getGitSnapshot } from '../repository.js';
import { defaultPrStatusCache, type PrStatusCache, type PrStatusCacheErrorKind, type PrStatusCacheKey } from '../hostingProviders/prStatusCache.js';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';
import { gitRemotePublish } from './publishOperations.js';
import { createValidatedPullRequestFollowupAction } from './pullRequestFollowupAction.js';
import { resolveDefaultPullRequestStatusProjectionRegistry } from './pullRequestStatusProjection.js';
import {
    evaluateDefaultBranchPullRequestPolicy,
    type DefaultBranchPullRequestAction,
} from './defaultBranchPullRequestPolicy.js';
import { resolvePullRequestBranchPublishPlan } from './pullRequestBranchPublishSafety.js';
import {
    matchesBranchHeadContext,
    readDuplicatePullRequestHint,
} from './pullRequestAuthChain.js';

type PullRequestWriteRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getAdapter' | 'buildCompareUrl'>;

type PullRequestWriteAdapter = Readonly<{
    getPullRequestAuthProfileKey?: (input: Readonly<{ provider: ScmHostingProviderRef }>) => string | null;
    listPullRequests?: (input: Readonly<{
        provider: ScmHostingProviderRef;
        base?: string;
        head: string;
        state?: ScmPullRequestState;
        runtimeServices?: ScmHostingProviderRuntimeServices;
    }>) => Promise<readonly ScmPullRequestSummary[]>;
    getPullRequest?: (input: Readonly<{
        provider: ScmHostingProviderRef;
        reference: ScmPullRequestReference;
        runtimeServices?: ScmHostingProviderRuntimeServices;
    }>) => Promise<ScmPullRequestSummary | null>;
    createPullRequest?: (input: Readonly<{
        provider: ScmHostingProviderRef;
        base: string;
        head: string;
        title: string;
        body?: string;
        runtimeServices?: ScmHostingProviderRuntimeServices;
    }>) => Promise<ScmPullRequestSummary>;
}>;

export type GitPullRequestOpenOrReuseOperation = Readonly<{
    openOrReuse(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestOpenOrReuseRequest;
    }>): Promise<ScmPullRequestOpenOrReuseResponse>;
}>;

type GitPullRequestOpenOrReuseOperationDeps = Readonly<{
    cache?: PrStatusCache;
    registry?: PullRequestWriteRegistry;
    runtimeServices?: ScmHostingProviderRuntimeServices;
    readSnapshot?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
    publishActiveBranch?: (input: Readonly<{
        context: ScmBackendContext;
        request: { cwd?: string };
        headBranch: string;
        reason: 'missing_upstream' | 'upstream_points_at_base';
    }>) => Promise<Readonly<{ success: boolean; error?: string; errorCode?: ScmOperationErrorCode }>>;
    now?: () => number;
}>;

function errorResponse(error: string, errorCode: ScmOperationErrorCode, extra?: Record<string, unknown>): ScmPullRequestOpenOrReuseResponse {
    return {
        success: false,
        error,
        errorCode,
        ...extra,
    };
}

function resolveProvider(snapshot: ScmWorkingSnapshot, providerId?: string): ScmHostingProviderRef | null {
    const provider = snapshot.hostingProvider ?? snapshot.pullRequestStatus?.provider ?? null;
    if (!provider) return null;
    if (providerId && provider.id !== providerId) return null;
    return {
        ...provider,
        urlSafety: provider.urlSafety ?? { allowedSchemes: ['https:'] },
    };
}

function isPullRequestWriteAdapter(adapter: unknown): adapter is PullRequestWriteAdapter {
    if (!adapter || typeof adapter !== 'object') return false;
    const candidate = adapter as Partial<Record<keyof PullRequestWriteAdapter, unknown>>;
    return typeof candidate.listPullRequests === 'function'
        || typeof candidate.getPullRequest === 'function'
        || typeof candidate.createPullRequest === 'function';
}

function readAuthProfileKey(adapter: PullRequestWriteAdapter | null, provider: ScmHostingProviderRef): string | undefined {
    const key = adapter?.getPullRequestAuthProfileKey?.({ provider })?.trim();
    return key ? key : undefined;
}

function buildCacheKey(input: Readonly<{
    context: ScmBackendContext;
    snapshot: ScmWorkingSnapshot;
    provider: ScmHostingProviderRef;
    baseBranch: string;
    headBranch: string;
    headRepositoryNameWithOwner?: string;
    authProfileKey?: string;
}>): PrStatusCacheKey {
    return {
        workspaceKey: input.context.projectKey,
        repoRootPath: input.snapshot.repo.rootPath ?? input.context.detection.rootPath ?? input.context.cwd,
        provider: input.provider,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        ...(input.headRepositoryNameWithOwner ? { headRepositoryNameWithOwner: input.headRepositoryNameWithOwner } : {}),
        state: 'open',
        ...(input.authProfileKey ? { authProfileKey: input.authProfileKey } : {}),
    };
}

function classifyError(error: unknown): Readonly<{
    message: string;
    code: ScmOperationErrorCode;
    cacheKind: PrStatusCacheErrorKind;
}> {
    const message = error instanceof Error ? error.message : 'Pull request provider operation failed';
    const maybeCode = typeof error === 'object' && error !== null
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    if (maybeCode === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED) {
        return { message, code: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED, cacheKind: 'auth' };
    }
    if (maybeCode === SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND) {
        return { message, code: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND, cacheKind: 'notFound' };
    }
    if (maybeCode === SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS) {
        return { message, code: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS, cacheKind: 'network' };
    }
    if (maybeCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
        return { message, code: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, cacheKind: 'network' };
    }
    return { message, code: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, cacheKind: 'network' };
}

function createSuccessfulResponse(input: Readonly<{
    pullRequest: ScmPullRequestSummary;
    provider: ScmHostingProviderRef;
    reused: boolean;
}>): ScmPullRequestOpenOrReuseResponse {
    return {
        success: true,
        pullRequest: input.pullRequest,
        reused: input.reused,
        nextAction: createValidatedPullRequestFollowupAction({
            provider: input.provider,
            purpose: 'pullRequest',
            url: input.pullRequest.url,
            allowedBaseUrl: input.provider.baseUrl,
        }),
        authState: 'authenticated',
    };
}

function findMatchingPullRequest(input: Readonly<{
    pullRequests: readonly ScmPullRequestSummary[];
    provider: ScmHostingProviderRef;
    baseBranch: string;
    headBranch: string;
    headRepositoryNameWithOwner?: string;
}>): ScmPullRequestSummary | null {
    return input.pullRequests.find((pullRequest) => matchesBranchHeadContext({
        pullRequest,
        provider: input.provider,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        ...(input.headRepositoryNameWithOwner ? { headRepositoryNameWithOwner: input.headRepositoryNameWithOwner } : {}),
    })) ?? null;
}

export function createGitPullRequestOpenOrReuseOperation(
    deps?: GitPullRequestOpenOrReuseOperationDeps,
): GitPullRequestOpenOrReuseOperation {
    const cache = deps?.cache ?? defaultPrStatusCache;

    function readRuntimeServices(): ScmHostingProviderRuntimeServices {
        if (deps?.runtimeServices) return deps.runtimeServices;
        const currentServices = readCurrentScmHostingProviderRuntimeServices();
        if (currentServices) return currentServices;
        if (deps?.registry) return {};
        throw new Error('Git SCM pull request operations require host-injected SCM hosting provider runtime services.');
    }

    const readSnapshot = deps?.readSnapshot ?? (async ({ context }) => {
        const response = await getGitSnapshot({ context });
        return response.success ? response.snapshot ?? null : null;
    });

    async function readRegistry(): Promise<PullRequestWriteRegistry> {
        return deps?.registry ?? await resolveDefaultPullRequestStatusProjectionRegistry();
    }

    async function publishActiveBranch(input: Readonly<{
        context: ScmBackendContext;
        request: { cwd?: string };
        headBranch: string;
        reason: 'missing_upstream' | 'upstream_points_at_base';
    }>): Promise<Readonly<{ success: boolean; error?: string; errorCode?: ScmOperationErrorCode }>> {
        if (deps?.publishActiveBranch) {
            return deps.publishActiveBranch(input);
        }
        return gitRemotePublish({
            context: input.context,
            request: input.request,
        });
    }

    async function readValidatedDuplicateHint(input: Readonly<{
        adapter: PullRequestWriteAdapter;
        provider: ScmHostingProviderRef;
        baseBranch: string;
        headBranch: string;
        headRepositoryNameWithOwner?: string;
        error: unknown;
    }>): Promise<ScmPullRequestSummary | null> {
        const hint = readDuplicatePullRequestHint(input.error);
        if (!hint) return null;
        let hintedPullRequest: ScmPullRequestSummary | null = null;
        try {
            hintedPullRequest = hint.kind === 'pullRequest'
                ? hint.pullRequest
                : input.adapter.getPullRequest
                    ? await input.adapter.getPullRequest({
                        provider: input.provider,
                        reference: hint.reference,
                        runtimeServices: readRuntimeServices(),
                    })
                    : null;
        } catch {
            return null;
        }
        if (!hintedPullRequest) return null;
        return matchesBranchHeadContext({
            pullRequest: hintedPullRequest,
            provider: input.provider,
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            ...(input.headRepositoryNameWithOwner ? { headRepositoryNameWithOwner: input.headRepositoryNameWithOwner } : {}),
        })
            ? hintedPullRequest
            : null;
    }

    return Object.freeze({
        async openOrReuse({ context, request }) {
            const snapshot = await readSnapshot({ context });
            if (!snapshot) {
                return errorResponse('SCM status snapshot is unavailable', SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
            }
            const provider = resolveProvider(snapshot, request.providerId);
            if (!provider) {
                return errorResponse('No supported SCM hosting provider detected for this repository', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
            }
            const resolvedProvider = provider;
            const headBranch = request.head ?? snapshot.branch.head;
            if (!headBranch || snapshot.branch.detached) {
                return errorResponse('Cannot open a pull request without an active branch', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
            }
            const resolvedHeadBranch = headBranch;
            const baseBranch = request.base;
            if (!baseBranch) {
                return errorResponse('Cannot open a pull request without a base branch', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
            }
            const resolvedBaseBranch = baseBranch;
            if (request.head?.trim() === resolvedBaseBranch) {
                return errorResponse(
                    'Create a feature branch before opening a pull request from the default branch',
                    SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                );
            }
            const requestedHeadRepositoryNameWithOwner = request.headRepositoryNameWithOwner?.trim() || undefined;
            const policy = evaluateDefaultBranchPullRequestPolicy({
                policy: request.defaultBranchPushPolicy ?? snapshot.capabilities.defaultBranchPushPolicy ?? 'deny',
                currentBranch: snapshot.branch.head,
                baseBranch: resolvedBaseBranch,
                branchAhead: snapshot.branch.ahead,
                requestedHeadBranch: request.head,
            });
            if (policy.kind === 'blocked') {
                return errorResponse(
                    'Create a feature branch before opening a pull request from the default branch',
                    policy.errorCode,
                    policy.action ? { defaultBranchAction: policy.action satisfies DefaultBranchPullRequestAction } : undefined,
                );
            }

            const registry = await readRegistry();
            const adapter = registry.getAdapter(resolvedProvider.id);
            const writeAdapter = isPullRequestWriteAdapter(adapter) ? adapter : null;
            const authProfileKey = readAuthProfileKey(writeAdapter, resolvedProvider);
            const buildResolvedCacheKey = (profileKey?: string): PrStatusCacheKey =>
                buildCacheKey({
                    context,
                    snapshot,
                    provider: resolvedProvider,
                    baseBranch: resolvedBaseBranch,
                    headBranch: resolvedHeadBranch,
                    ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                    authProfileKey: profileKey,
                });
            const readCurrentCacheKey = (): PrStatusCacheKey =>
                buildResolvedCacheKey(readAuthProfileKey(writeAdapter, resolvedProvider));
            const cacheKey = buildResolvedCacheKey(authProfileKey);

            const cached = cache.getFresh(cacheKey);
            if (cached?.kind === 'success') {
                const cachedMatch = findMatchingPullRequest({
                    pullRequests: cached.pullRequests,
                    provider: resolvedProvider,
                    baseBranch: resolvedBaseBranch,
                    headBranch: resolvedHeadBranch,
                    ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                });
                if (cachedMatch) {
                    return createSuccessfulResponse({ pullRequest: cachedMatch, provider: resolvedProvider, reused: true });
                }
            }

            const compareUrl = registry.buildCompareUrl({
                provider: resolvedProvider,
                base: resolvedBaseBranch,
                head: resolvedHeadBranch,
            });

            function composeFallback(): ScmPullRequestOpenOrReuseResponse {
                if (compareUrl.kind !== 'resolved') {
                    return errorResponse('SCM hosting provider does not support pull request creation', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
                }
                return {
                    success: true,
                    pullRequest: null,
                    reused: false,
                    composeUrl: compareUrl.url,
                    nextAction: createValidatedPullRequestFollowupAction({
                        provider: resolvedProvider,
                        purpose: 'compose',
                        url: compareUrl.url,
                        allowedBaseUrl: resolvedProvider.baseUrl,
                    }),
                    authState: 'authentication_required',
                };
            }

            if (!writeAdapter?.createPullRequest) {
                return composeFallback();
            }

            async function listOpenPullRequests(): Promise<readonly ScmPullRequestSummary[]> {
                if (!writeAdapter?.listPullRequests) return [];
                return await writeAdapter.listPullRequests({
                    provider: resolvedProvider,
                    base: resolvedBaseBranch,
                    head: resolvedHeadBranch,
                    state: 'open',
                    runtimeServices: readRuntimeServices(),
                });
            }

            try {
                const existing = findMatchingPullRequest({
                    pullRequests: await listOpenPullRequests(),
                    provider: resolvedProvider,
                    baseBranch: resolvedBaseBranch,
                    headBranch: resolvedHeadBranch,
                    ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                });
                if (existing) {
                    cache.setSuccess({ key: readCurrentCacheKey(), pullRequests: [existing] });
                    return createSuccessfulResponse({ pullRequest: existing, provider: resolvedProvider, reused: true });
                }
            } catch (error) {
                const classified = classifyError(error);
                cache.setError({
                    key: cacheKey,
                    error: classified.message,
                    errorCode: classified.code,
                    errorKind: classified.cacheKind,
                });
                if (classified.code === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED || classified.code === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
                    return composeFallback();
                }
                return errorResponse(classified.message, classified.code);
            }

            if (snapshot.branch.head === resolvedHeadBranch && resolvedHeadBranch !== resolvedBaseBranch) {
                const plan = resolvePullRequestBranchPublishPlan({
                    activeBranch: resolvedHeadBranch,
                    baseBranch: resolvedBaseBranch,
                    upstream: snapshot.branch.upstream,
                });
                if (plan.kind === 'publish_active_branch') {
                    const published = await publishActiveBranch({
                        context,
                        request: {
                            ...(request.cwd ? { cwd: request.cwd } : {}),
                        },
                        headBranch: resolvedHeadBranch,
                        reason: plan.reason,
                    });
                    if (!published.success) {
                        return errorResponse(
                            published.error ?? 'Failed to publish active branch before opening pull request',
                            published.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        );
                    }
                }
            }

            try {
                const created = await writeAdapter.createPullRequest({
                    provider: resolvedProvider,
                    base: resolvedBaseBranch,
                    head: resolvedHeadBranch,
                    title: request.title ?? resolvedHeadBranch,
                    ...(request.body !== undefined ? { body: request.body } : {}),
                    runtimeServices: readRuntimeServices(),
                });
                if (!matchesBranchHeadContext({
                    pullRequest: created,
                    provider: resolvedProvider,
                    baseBranch: resolvedBaseBranch,
                    headBranch: resolvedHeadBranch,
                    ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                })) {
                    return errorResponse(
                        'Pull request provider returned a pull request outside the requested branch context.',
                        SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    );
                }
                invalidatePrStatusCacheAfterSuccessfulScmMutation({
                    cache,
                    response: { success: true },
                    context,
                    headBranch: resolvedHeadBranch,
                });
                cache.setSuccess({ key: readCurrentCacheKey(), pullRequests: [created] });
                return createSuccessfulResponse({ pullRequest: created, provider: resolvedProvider, reused: false });
            } catch (error) {
                const duplicateHint = await readValidatedDuplicateHint({
                    adapter: writeAdapter,
                    provider: resolvedProvider,
                    baseBranch: resolvedBaseBranch,
                    headBranch: resolvedHeadBranch,
                    ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                    error,
                });
                if (duplicateHint) {
                    cache.setSuccess({ key: readCurrentCacheKey(), pullRequests: [duplicateHint] });
                    return createSuccessfulResponse({ pullRequest: duplicateHint, provider: resolvedProvider, reused: true });
                }
                let listedAfterDuplicate: ScmPullRequestSummary | null = null;
                try {
                    listedAfterDuplicate = findMatchingPullRequest({
                        pullRequests: await listOpenPullRequests(),
                        provider: resolvedProvider,
                        baseBranch: resolvedBaseBranch,
                        headBranch: resolvedHeadBranch,
                        ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                    });
                } catch {
                    listedAfterDuplicate = null;
                }
                if (listedAfterDuplicate) {
                    cache.setSuccess({ key: readCurrentCacheKey(), pullRequests: [listedAfterDuplicate] });
                    return createSuccessfulResponse({ pullRequest: listedAfterDuplicate, provider: resolvedProvider, reused: true });
                }
                const classified = classifyError(error);
                if (classified.code === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED || classified.code === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
                    return composeFallback();
                }
                return errorResponse(classified.message, classified.code);
            }
        },
    });
}

const gitPullRequestOpenOrReuseOperation = createGitPullRequestOpenOrReuseOperation();

export const gitPullRequestOpenOrReuse = gitPullRequestOpenOrReuseOperation.openOrReuse;
