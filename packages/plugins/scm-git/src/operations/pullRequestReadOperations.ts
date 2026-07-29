import {
  SCM_OPERATION_ERROR_CODES,
  type ScmHostingProviderRef,
  type ScmOperationErrorCode,
  type ScmPullRequestGetRequest,
  type ScmPullRequestGetResponse,
  type ScmPullRequestListRequest,
  type ScmPullRequestListResponse,
  type ScmPullRequestOpenComposeRequest,
  type ScmPullRequestOpenComposeResponse,
  type ScmPullRequestReference,
  type ScmPullRequestState,
  type ScmPullRequestSummary,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/experimental/scm';
import {
    readCurrentScmHostingProviderRuntimeServices,
    type ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';

import type { ScmBackendContext } from '../types.js';
import { getGitSnapshot } from '../repository.js';
import { defaultPrStatusCache, type PrStatusCache, type PrStatusCacheErrorKind, type PrStatusCacheKey } from '../hostingProviders/prStatusCache.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';
import { createValidatedPullRequestFollowupAction } from './pullRequestFollowupAction.js';
import { parsePullRequestReference } from './pullRequestReference.js';
import {
    resolveDefaultPullRequestStatusProjectionRegistry,
    resolvePullRequestBaseBranch,
} from './pullRequestStatusProjection.js';

type PullRequestReadRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getAdapter' | 'buildCompareUrl'>;

type PullRequestListHookInput = Readonly<{
    provider: ScmHostingProviderRef;
    base?: string;
    head: string;
    state?: ScmPullRequestState;
    runtimeServices?: ScmHostingProviderRuntimeServices;
}>;

type PullRequestGetHookInput = Readonly<{
    provider: ScmHostingProviderRef;
    reference: ScmPullRequestReference;
    runtimeServices?: ScmHostingProviderRuntimeServices;
}>;

type PullRequestReadAdapter = Readonly<{
    getPullRequestAuthProfileKey?: (input: Readonly<{ provider: ScmHostingProviderRef }>) => string | null;
    listPullRequests?: (input: PullRequestListHookInput) => Promise<readonly ScmPullRequestSummary[]>;
    getPullRequest?: (input: PullRequestGetHookInput) => Promise<ScmPullRequestSummary | null>;
}>;

export type GitPullRequestReadOperations = Readonly<{
    list(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestListRequest;
    }>): Promise<ScmPullRequestListResponse>;
    get(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestGetRequest;
    }>): Promise<ScmPullRequestGetResponse>;
    openCompose(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestOpenComposeRequest;
    }>): Promise<ScmPullRequestOpenComposeResponse>;
}>;

type GitPullRequestReadOperationDeps = Readonly<{
    cache?: PrStatusCache;
    registry?: PullRequestReadRegistry;
    runtimeServices?: ScmHostingProviderRuntimeServices;
    readSnapshot?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
    now?: () => number;
}>;

function errorResponse(error: string, errorCode: ScmOperationErrorCode): {
    success: false;
    error: string;
    errorCode: ScmOperationErrorCode;
} {
    return {
        success: false,
        error,
        errorCode,
    };
}

function isPullRequestReadAdapter(adapter: unknown): adapter is PullRequestReadAdapter {
    if (!adapter || typeof adapter !== 'object') return false;
    const candidate = adapter as Partial<Record<keyof PullRequestReadAdapter, unknown>>;
    return typeof candidate.listPullRequests === 'function'
        || typeof candidate.getPullRequest === 'function'
        || typeof candidate.getPullRequestAuthProfileKey === 'function';
}

function resolveProvider(snapshot: ScmWorkingSnapshot, providerId?: string): ScmHostingProviderRef | null {
    const provider = snapshot.hostingProvider ?? snapshot.pullRequestStatus?.provider ?? null;
    if (!provider) return null;
    if (providerId && provider.id !== providerId) return null;
    return {
        ...provider,
        urlSafety: 'urlSafety' in provider && provider.urlSafety
            ? provider.urlSafety as ScmHostingProviderRef['urlSafety']
            : { allowedSchemes: ['https:'] },
    };
}

function resolveHeadBranch(snapshot: ScmWorkingSnapshot, requestHead?: string): string | null {
    return requestHead ?? snapshot.branch.head ?? null;
}

function buildCacheKey(input: Readonly<{
    context: ScmBackendContext;
    snapshot: ScmWorkingSnapshot;
    provider: ScmHostingProviderRef;
    baseBranch: string | null;
    headBranch: string;
    state?: ScmPullRequestState;
    authProfileKey?: string;
}>): PrStatusCacheKey {
    return {
        workspaceKey: input.context.projectKey,
        repoRootPath: input.snapshot.repo.rootPath ?? input.context.detection.rootPath ?? input.context.cwd,
        provider: input.provider,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        ...(input.state ? { state: input.state } : {}),
        ...(input.authProfileKey ? { authProfileKey: input.authProfileKey } : {}),
    };
}

function readAuthProfileKey(adapter: PullRequestReadAdapter, provider: ScmHostingProviderRef): string | undefined {
    const key = adapter.getPullRequestAuthProfileKey?.({ provider })?.trim();
    return key ? key : undefined;
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
    return { message, code: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, cacheKind: 'network' };
}

function matchesReference(pr: ScmPullRequestSummary, reference: ScmPullRequestReference): boolean {
    if ('number' in reference) return pr.number === reference.number;
    if ('headBranch' in reference) return pr.headBranch === reference.headBranch;
    if ('url' in reference) {
        if (pr.url === reference.url) return true;
        const parsed = parsePullRequestReference(reference.url);
        return parsed.ok && 'number' in parsed.reference && pr.number === parsed.reference.number;
    }
    return false;
}

export function createGitPullRequestReadOperations(
    deps?: GitPullRequestReadOperationDeps,
): GitPullRequestReadOperations {
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

    async function readRegistry(): Promise<PullRequestReadRegistry> {
        return deps?.registry ?? await resolveDefaultPullRequestStatusProjectionRegistry();
    }

    async function readProviderContext(input: Readonly<{
        context: ScmBackendContext;
        providerId?: string;
    }>): Promise<Readonly<{
        snapshot: ScmWorkingSnapshot;
        provider: ScmHostingProviderRef;
        registry: PullRequestReadRegistry;
        adapter: PullRequestReadAdapter | null;
    }> | { error: ScmPullRequestListResponse & ScmPullRequestGetResponse & ScmPullRequestOpenComposeResponse }> {
        const snapshot = await readSnapshot({ context: input.context });
        if (!snapshot) {
            return { error: errorResponse('SCM status snapshot is unavailable', SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) };
        }
        const provider = resolveProvider(snapshot, input.providerId);
        if (!provider) {
            return { error: errorResponse('No supported SCM hosting provider detected for this repository', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) };
        }
        const registry = await readRegistry();
        const rawAdapter = registry.getAdapter(provider.id);
        return {
            snapshot,
            provider,
            registry,
            adapter: isPullRequestReadAdapter(rawAdapter) ? rawAdapter : null,
        };
    }

    async function list(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestListRequest;
    }>): Promise<ScmPullRequestListResponse> {
        const { context, request } = input;
        const resolved = await readProviderContext({
            context,
            providerId: request.providerId,
        });
        if ('error' in resolved) return resolved.error;

        const headBranch = resolveHeadBranch(resolved.snapshot, request.head);
        if (!headBranch) {
            return errorResponse('Cannot list pull requests without a head branch', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }
        const baseBranch = request.base ?? resolvePullRequestBaseBranch(resolved.snapshot);
        const authProfileKey = resolved.adapter ? readAuthProfileKey(resolved.adapter, resolved.provider) : undefined;
        const key = buildCacheKey({
            context,
            snapshot: resolved.snapshot,
            provider: resolved.provider,
            baseBranch,
            headBranch,
            state: request.state,
            authProfileKey,
        });
        const fresh = authProfileKey ? cache.getFresh(key) : null;
        if (fresh?.kind === 'success') {
            return { success: true, pullRequests: [...fresh.pullRequests] };
        }
        if (!resolved.adapter?.listPullRequests) {
            return errorResponse('SCM hosting provider does not support pull request listing', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        }
        try {
            const pullRequests = await resolved.adapter.listPullRequests({
                provider: resolved.provider,
                ...(baseBranch ? { base: baseBranch } : {}),
                head: headBranch,
                ...(request.state ? { state: request.state } : {}),
                runtimeServices: readRuntimeServices(),
            });
            const currentAuthProfileKey = readAuthProfileKey(resolved.adapter, resolved.provider);
            const writeKey = currentAuthProfileKey === authProfileKey
                ? key
                : buildCacheKey({
                    context,
                    snapshot: resolved.snapshot,
                    provider: resolved.provider,
                    baseBranch,
                    headBranch,
                    state: request.state,
                    authProfileKey: currentAuthProfileKey,
                });
            if (currentAuthProfileKey) {
                cache.setSuccess({ key: writeKey, pullRequests });
            }
            return { success: true, pullRequests: [...pullRequests] };
        } catch (error) {
            const classified = classifyError(error);
            const currentAuthProfileKey = resolved.adapter ? readAuthProfileKey(resolved.adapter, resolved.provider) : undefined;
            const writeKey = currentAuthProfileKey === authProfileKey
                ? key
                : buildCacheKey({
                    context,
                    snapshot: resolved.snapshot,
                    provider: resolved.provider,
                    baseBranch,
                    headBranch,
                    state: request.state,
                    authProfileKey: currentAuthProfileKey,
                });
            if (currentAuthProfileKey) {
                cache.setError({
                    key: writeKey,
                    error: classified.message,
                    errorCode: classified.code,
                    errorKind: classified.cacheKind,
                });
            }
            return errorResponse(classified.message, classified.code);
        }
    }

    return Object.freeze({
        list,
        async get({ context, request }) {
            const resolved = await readProviderContext({ context });
            if ('error' in resolved) return resolved.error;
            if (resolved.adapter?.getPullRequest) {
                try {
                    const pullRequest = await resolved.adapter.getPullRequest({
                        provider: resolved.provider,
                        reference: request.prReference,
                        runtimeServices: readRuntimeServices(),
                    });
                    return { success: true, pullRequest };
                } catch (error) {
                    const classified = classifyError(error);
                    return errorResponse(classified.message, classified.code);
                }
            }

            if (!('headBranch' in request.prReference)) {
                return errorResponse('SCM hosting provider does not support explicit pull request lookup', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
            }

            const headBranch = typeof request.prReference.headBranch === 'string'
                ? request.prReference.headBranch
                : null;
            if (headBranch) {
                const base = resolvePullRequestBaseBranch(resolved.snapshot);
                const listResult = await list({
                    context,
                    request: {
                        ...(request.cwd ? { cwd: request.cwd } : {}),
                        ...(request.backendPreference ? { backendPreference: request.backendPreference } : {}),
                        providerId: resolved.provider.id,
                        ...(base ? { base } : {}),
                        head: headBranch,
                        state: 'open',
                    },
                });
                if (!listResult.success) return listResult;
                return {
                    success: true,
                    pullRequest: listResult.pullRequests.find((pr) => matchesReference(pr, request.prReference)) ?? null,
                };
            }

            return errorResponse('SCM hosting provider does not support pull request lookup', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        },
        async openCompose({ context, request }) {
            const resolved = await readProviderContext({
                context,
                providerId: request.providerId,
            });
            if ('error' in resolved) return resolved.error;

            const compareUrl = resolved.registry.buildCompareUrl({
                provider: resolved.provider,
                base: request.base,
                head: request.head,
            });
            if (compareUrl.kind !== 'resolved') {
                return errorResponse('SCM hosting provider does not support pull request compose URLs', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
            }
            return {
                success: true,
                composeUrl: compareUrl.url,
                nextAction: createValidatedPullRequestFollowupAction({
                    provider: resolved.provider,
                    purpose: 'compose',
                    url: compareUrl.url,
                    allowedBaseUrl: resolved.provider.baseUrl,
                }),
            };
        },
    });
}

const gitPullRequestReadOperations = createGitPullRequestReadOperations();

export const gitPullRequestList = gitPullRequestReadOperations.list;
export const gitPullRequestGet = gitPullRequestReadOperations.get;
export const gitPullRequestOpenCompose = gitPullRequestReadOperations.openCompose;
