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
} from '@happier-dev/protocol';
import type { ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';

import type { ScmBackendContext } from '../../../types';
import { getGitSnapshot } from '../repository';
import { defaultPrStatusCache, type PrStatusCache, type PrStatusCacheErrorKind, type PrStatusCacheKey } from '../hostingProviders/prStatusCache';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types';
import { createScmHostingProviderRuntimeServices } from '../hostingProviders/runtimeServices';
import { gitRemotePublish } from './publishOperations';
import { resolveDefaultPullRequestStatusProjectionRegistry } from './pullRequestStatusProjection';
import {
    evaluateDefaultBranchPullRequestPolicy,
    type DefaultBranchPullRequestAction,
} from './defaultBranchPullRequestPolicy';
import { resolvePullRequestBranchPublishPlan } from './pullRequestBranchPublishSafety';
import {
    matchesBranchHeadContext,
    readDuplicatePullRequestHint,
} from './pullRequestAuthChain';

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

function normalizeUpstreamBranch(upstream: string | null): string | null {
    if (!upstream) return null;
    const slashIndex = upstream.indexOf('/');
    if (slashIndex < 0) return upstream;
    return upstream.slice(slashIndex + 1) || null;
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
    authProfileKey?: string;
}>): PrStatusCacheKey {
    return {
        workspaceKey: input.context.projectKey,
        repoRootPath: input.snapshot.repo.rootPath ?? input.context.detection.rootPath ?? input.context.cwd,
        provider: input.provider,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
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
    reused: boolean;
}>): ScmPullRequestOpenOrReuseResponse {
    return {
        success: true,
        pullRequest: input.pullRequest,
        reused: input.reused,
        nextAction: {
            kind: 'openUrl',
            purpose: 'pullRequest',
            url: input.pullRequest.url,
            allowedBaseUrl: input.pullRequest.provider.baseUrl,
            urlSafety: input.pullRequest.provider.urlSafety,
        },
        authState: 'authenticated',
    };
}

function findMatchingPullRequest(input: Readonly<{
    pullRequests: readonly ScmPullRequestSummary[];
    provider: ScmHostingProviderRef;
    baseBranch: string;
    headBranch: string;
}>): ScmPullRequestSummary | null {
    return input.pullRequests.find((pullRequest) => matchesBranchHeadContext({
        pullRequest,
        provider: input.provider,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
    })) ?? null;
}

export function createGitPullRequestOpenOrReuseOperation(
    deps?: GitPullRequestOpenOrReuseOperationDeps,
): GitPullRequestOpenOrReuseOperation {
    const cache = deps?.cache ?? defaultPrStatusCache;
    let defaultRuntimeServices: ScmHostingProviderRuntimeServices | null = null;

    function readRuntimeServices(): ScmHostingProviderRuntimeServices {
        if (deps?.runtimeServices) return deps.runtimeServices;
        defaultRuntimeServices ??= createScmHostingProviderRuntimeServices();
        return defaultRuntimeServices;
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
        error: unknown;
    }>): Promise<ScmPullRequestSummary | null> {
        const hint = readDuplicatePullRequestHint(input.error);
        if (!hint) return null;
        const hintedPullRequest = hint.kind === 'pullRequest'
            ? hint.pullRequest
            : input.adapter.getPullRequest
                ? await input.adapter.getPullRequest({
                    provider: input.provider,
                    reference: hint.reference,
                    runtimeServices: readRuntimeServices(),
                })
                : null;
        if (!hintedPullRequest) return null;
        return matchesBranchHeadContext({
            pullRequest: hintedPullRequest,
            provider: input.provider,
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
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
            const headBranch = request.head ?? snapshot.branch.head;
            if (!headBranch || snapshot.branch.detached) {
                return errorResponse('Cannot open a pull request without an active branch', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
            }
            const baseBranch = request.base;
            const policy = evaluateDefaultBranchPullRequestPolicy({
                policy: snapshot.capabilities.defaultBranchPushPolicy ?? 'deny',
                currentBranch: snapshot.branch.head,
                baseBranch,
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
            const adapter = registry.getAdapter(provider.id);
            const writeAdapter = isPullRequestWriteAdapter(adapter) ? adapter : null;
            const authProfileKey = readAuthProfileKey(writeAdapter, provider);
            const cacheKey = buildCacheKey({
                context,
                snapshot,
                provider,
                baseBranch,
                headBranch,
                authProfileKey,
            });

            const cached = cache.getFresh(cacheKey);
            if (cached?.kind === 'success') {
                const cachedMatch = findMatchingPullRequest({
                    pullRequests: cached.pullRequests,
                    provider,
                    baseBranch,
                    headBranch,
                });
                if (cachedMatch) {
                    return createSuccessfulResponse({ pullRequest: cachedMatch, reused: true });
                }
            }

            const compareUrl = registry.buildCompareUrl({
                provider,
                base: baseBranch,
                head: headBranch,
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
                    nextAction: {
                        kind: 'openUrl',
                        purpose: 'compose',
                        url: compareUrl.url,
                        allowedBaseUrl: provider.baseUrl,
                        urlSafety: provider.urlSafety,
                    },
                    authState: 'authentication_required',
                };
            }

            if (!writeAdapter?.createPullRequest) {
                return composeFallback();
            }

            async function listOpenPullRequests(): Promise<readonly ScmPullRequestSummary[]> {
                if (!writeAdapter?.listPullRequests) return [];
                return await writeAdapter.listPullRequests({
                    provider,
                    base: baseBranch,
                    head: headBranch,
                    state: 'open',
                    runtimeServices: readRuntimeServices(),
                });
            }

            try {
                const existing = findMatchingPullRequest({
                    pullRequests: await listOpenPullRequests(),
                    provider,
                    baseBranch,
                    headBranch,
                });
                if (existing) {
                    cache.setSuccess({ key: cacheKey, pullRequests: [existing] });
                    return createSuccessfulResponse({ pullRequest: existing, reused: true });
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

            if (snapshot.branch.head === headBranch && headBranch !== baseBranch) {
                const plan = resolvePullRequestBranchPublishPlan({
                    activeBranch: headBranch,
                    baseBranch,
                    upstream: snapshot.branch.upstream,
                });
                if (plan.kind === 'publish_active_branch') {
                    const published = await publishActiveBranch({
                        context,
                        request: {
                            ...(request.cwd ? { cwd: request.cwd } : {}),
                        },
                        headBranch,
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
                    provider,
                    base: baseBranch,
                    head: headBranch,
                    title: request.title ?? headBranch,
                    ...(request.body !== undefined ? { body: request.body } : {}),
                    runtimeServices: readRuntimeServices(),
                });
                invalidatePrStatusCacheAfterSuccessfulScmMutation({
                    cache,
                    response: { success: true },
                    context,
                    headBranch,
                });
                cache.setSuccess({ key: cacheKey, pullRequests: [created] });
                return createSuccessfulResponse({ pullRequest: created, reused: false });
            } catch (error) {
                const duplicateHint = await readValidatedDuplicateHint({
                    adapter: writeAdapter,
                    provider,
                    baseBranch,
                    headBranch,
                    error,
                });
                if (duplicateHint) {
                    cache.setSuccess({ key: cacheKey, pullRequests: [duplicateHint] });
                    return createSuccessfulResponse({ pullRequest: duplicateHint, reused: true });
                }
                const listedAfterDuplicate = findMatchingPullRequest({
                    pullRequests: await listOpenPullRequests(),
                    provider,
                    baseBranch,
                    headBranch,
                });
                if (listedAfterDuplicate) {
                    cache.setSuccess({ key: cacheKey, pullRequests: [listedAfterDuplicate] });
                    return createSuccessfulResponse({ pullRequest: listedAfterDuplicate, reused: true });
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
