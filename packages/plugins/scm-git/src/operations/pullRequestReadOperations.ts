import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
  type ScmPullRequestGetRequest,
  type ScmPullRequestGetResponse,
  type ScmPullRequestListRequest,
  type ScmPullRequestListResponse,
  type ScmPullRequestOpenComposeRequest,
  type ScmPullRequestOpenComposeResponse,
  type ScmPullRequestState,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
  type HostingProviderPullRequestsCapability,
  type ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { type HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { readCurrentHostingProviderRuntimeServices as readCurrentScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';

import { projectScmBackendFailure, type BackendRuntimeHandlers } from '@happier-dev/plugin-sdk/scm/backend';

import type { ScmBackendContext } from '../types.js';
import { getGitSnapshot } from '../repository.js';
import { defaultPrStatusCache, readPrStatusProjectionScope, type PrStatusCache, type PrStatusCacheKey } from '../hostingProviders/prStatusCache.js';
import { classifyHostingProviderError } from '../hostingProviders/providerFailure.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';
import { createValidatedPullRequestFollowupAction } from './pullRequestFollowupAction.js';
import { readPullRequestTemplate } from './pullRequestTemplate.js';
import {
    resolveDefaultPullRequestStatusProjectionRegistry,
    resolvePullRequestBaseBranch,
} from './pullRequestStatusProjection.js';

type PullRequestReadRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getPullRequests' | 'buildCompareUrl' | 'detectRemote'>
    & Partial<Pick<ResolvedScmHostingProviderRegistry, 'getRepositoryPublishing'>>;

type PullRequestListStates = NonNullable<NonNullable<BackendRuntimeHandlers['hosting']>['pullRequestListStates']>;

export type GitPullRequestReadOperations = Readonly<{
    listStates(input: Readonly<{
        context: ScmBackendContext;
        request: Parameters<PullRequestListStates>[0]['request'];
    }>): ReturnType<PullRequestListStates>;
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

function errorResponse(error: string, errorCode: ScmOperationErrorCode, details?: ReturnType<typeof classifyHostingProviderError>['details']): {
    success: false;
    error: string;
    errorCode: ScmOperationErrorCode;
} {
    return {
        success: false,
        error,
        errorCode,
        ...details,
    };
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

function readAuthProfileKey(adapter: HostingProviderPullRequestsCapability, provider: ScmHostingProviderRef): string | undefined {
    const key = adapter.getPullRequestAuthProfileKey({ provider })?.trim();
    return key ? key : undefined;
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
        adapter: HostingProviderPullRequestsCapability | null;
    }> | { error: ScmPullRequestListResponse & ScmPullRequestGetResponse & ScmPullRequestOpenComposeResponse }> {
        let registry: PullRequestReadRegistry | undefined;
        let snapshot: ScmWorkingSnapshot | null;
        if (deps?.readSnapshot) {
            snapshot = await deps.readSnapshot({ context: input.context });
        } else {
            // Snapshot detection and this operation consume one hosting observation.
            const response = await getGitSnapshot({
                context: input.context,
                resolveHostingProviderRegistry: async () => registry = await readRegistry(),
            });
            snapshot = response.success ? response.snapshot ?? null : null;
        }
        if (!snapshot) {
            return { error: errorResponse('SCM status snapshot is unavailable', SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) };
        }
        const provider = resolveProvider(snapshot, input.providerId);
        if (!provider) {
            return { error: errorResponse('No supported SCM hosting provider detected for this repository', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) };
        }
        registry ??= await readRegistry();
        return {
            snapshot,
            provider,
            registry,
            adapter: registry.getPullRequests(provider.id) ?? null,
        };
    }

    async function list(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestListRequest;
    }>): Promise<ScmPullRequestListResponse> {
        const { context, request } = input;
        const resolved = await readProviderContext({ context, providerId: request.providerId });
        return listWithProviderContext({ context, request, resolved });
    }

    async function listWithProviderContext(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestListRequest;
        resolved: Awaited<ReturnType<typeof readProviderContext>>;
    }>): Promise<ScmPullRequestListResponse> {
        const { context, request, resolved } = input;
        if ('error' in resolved) return resolved.error;

        const headBranch = resolveHeadBranch(resolved.snapshot, request.head);
        if (!headBranch) {
            return errorResponse('Cannot list pull requests without a head branch', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }
        // A branch hint can target any base; filter only when the caller chose one.
        const baseBranch = request.base ?? null;
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
        if (!resolved.adapter) {
            return errorResponse('SCM hosting provider does not support pull request listing', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        }
        const projectionScope = readPrStatusProjectionScope();
        try {
            const pullRequests = await resolved.adapter.listPullRequests({
                provider: resolved.provider,
                ...(baseBranch ? { base: baseBranch } : {}),
                head: headBranch,
                ...(request.state ? { state: request.state } : {}),
                runtimeServices: readRuntimeServices(),
            });
            let defaultBranch = cache.getRepositoryDefaultBranch(key, projectionScope);
            const repositoryAdapter = resolved.registry.getRepositoryPublishing?.(resolved.provider.id);
            const repository = resolved.provider.nameWithOwner;
            const separator = repository?.lastIndexOf('/') ?? -1;
            if (!resolved.snapshot.repo.defaultBranch && repositoryAdapter && repository && separator > 0) {
                // Optional repository metadata shares the demanded branch observation, not snapshot refreshes.
                const metadata = await repositoryAdapter.getRepository({
                    provider: resolved.provider,
                    owner: repository.slice(0, separator),
                    repositoryName: repository.slice(separator + 1),
                    runtimeServices: readRuntimeServices(),
                }).catch(() => null);
                defaultBranch = metadata?.defaultBranch?.trim() || null;
            }
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
                cache.setSuccess({ key: writeKey, pullRequests, ...(defaultBranch ? { defaultBranch } : {}) });
            } else if (projectionScope === 'localOwner') {
                // The host authenticated this observation without a reusable credential identity.
                cache.setSuccess({ key: { ...writeKey, localOwnerObservation: true }, pullRequests,
                    ...(defaultBranch ? { defaultBranch } : {}) });
            }
            return { success: true, pullRequests: [...pullRequests] };
        } catch (error) {
            const classified = classifyHostingProviderError(error);
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
            if (currentAuthProfileKey || projectionScope === 'localOwner') {
                cache.setError({
                    key: currentAuthProfileKey ? writeKey : { ...writeKey, localOwnerObservation: true },
                    error: classified.message,
                    errorCode: classified.code,
                    errorKind: classified.cacheKind,
                });
            }
            return errorResponse(classified.message, classified.code, classified.details);
        }
    }

    return Object.freeze({
        list,
        async listStates({ context, request }) {
            const resolved = await readProviderContext({ context });
            return {
                results: await Promise.all(request.states.map(async state => {
                    try {
                        const response = await listWithProviderContext({ context, request: { state }, resolved });
                        return response.success ? { ok: true, response } : { ok: false, error: response };
                    } catch (error) {
                        return { ok: false, error: projectScmBackendFailure(error) };
                    }
                })),
            };
        },
        async get({ context, request }) {
            const resolved = await readProviderContext({ context });
            if ('error' in resolved) return resolved.error;
            if (!resolved.adapter) {
                return errorResponse('SCM hosting provider does not support pull request lookup', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
            }
            try {
                const pullRequest = await resolved.adapter.getPullRequest({
                    provider: resolved.provider,
                    reference: request.prReference,
                    runtimeServices: readRuntimeServices(),
                });
                return { success: true, pullRequest };
            } catch (error) {
                const classified = classifyHostingProviderError(error);
                return errorResponse(classified.message, classified.code, classified.details);
            }
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
                ...(request.includeTemplate ? { template: await readPullRequestTemplate({
                    cwd: resolved.snapshot.repo.rootPath ?? context.cwd, base: request.base,
                    remoteName: resolved.provider.remoteName, providerKind: resolved.provider.kind,
                }) } : {}),
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
export const gitPullRequestListStates = gitPullRequestReadOperations.listStates;
export const gitPullRequestGet = gitPullRequestReadOperations.get;
export const gitPullRequestOpenCompose = gitPullRequestReadOperations.openCompose;
