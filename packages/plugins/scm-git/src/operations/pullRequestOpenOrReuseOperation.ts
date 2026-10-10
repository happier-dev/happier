import {
  SCM_OPERATION_ERROR_CODES,
  normalizeScmOperationOutcome,
  type ScmOperationErrorCode,
  type ScmPullRequestOpenOrReuseRequest,
  type ScmPullRequestOpenOrReuseResponse,
  type ScmPullRequestSummary,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
  type HostingProviderPullRequestsCapability,
  type ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import {
    readCurrentHostingProviderRuntimeServices as readCurrentScmHostingProviderRuntimeServices,
    type HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';

import type { ScmBackendContext } from '../types.js';
import { getGitSnapshot } from '../repository.js';
import { defaultPrStatusCache, type PrStatusCache, type PrStatusCacheKey } from '../hostingProviders/prStatusCache.js';
import { classifyHostingProviderError } from '../hostingProviders/providerFailure.js';
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
import { readPullRequestTemplate } from './pullRequestTemplate.js';

type PullRequestWriteRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getPullRequests' | 'buildCompareUrl'>;

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
        outcome: errorCode === SCM_OPERATION_ERROR_CODES.INVALID_REQUEST
            ? { v: 1, kind: 'needs_input', errorCode, nextActions: [] }
            : normalizeScmOperationOutcome({ success: false, errorCode, error }),
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

function readAuthProfileKey(adapter: HostingProviderPullRequestsCapability | null, provider: ScmHostingProviderRef): string | undefined {
    const key = adapter?.getPullRequestAuthProfileKey({ provider })?.trim();
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

function createSuccessfulResponse(input: Readonly<{
    pullRequest: ScmPullRequestSummary;
    provider: ScmHostingProviderRef;
    reused: boolean;
}>): ScmPullRequestOpenOrReuseResponse {
    return {
        success: true,
        pullRequest: input.pullRequest,
        reused: input.reused,
        result: input.reused ? 'reused' : 'created',
        outcome: {
            v: 1, kind: 'succeeded', nextActions: [],
            effect: {
                kind: 'pull_request', url: input.pullRequest.url,
                ...(typeof input.pullRequest.number === 'number' ? { number: input.pullRequest.number } : {}),
            },
        },
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
        adapter: HostingProviderPullRequestsCapability;
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
                : await input.adapter.getPullRequest({
                    provider: input.provider,
                    reference: hint.reference,
                    runtimeServices: readRuntimeServices(),
                });
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
            const writeAdapter = registry.getPullRequests(resolvedProvider.id) ?? null;
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
            const readCurrentCacheKey = (): PrStatusCacheKey | null => {
                const currentAuthProfileKey =
                    readAuthProfileKey(writeAdapter, resolvedProvider);
                return currentAuthProfileKey
                    ? buildResolvedCacheKey(currentAuthProfileKey)
                    : null;
            };
            const cacheKey = buildResolvedCacheKey(authProfileKey);

            const cached = authProfileKey ? cache.getFresh(cacheKey) : null;
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

            function composeFallback(errorCode: ScmOperationErrorCode = SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED): ScmPullRequestOpenOrReuseResponse {
                if (compareUrl.kind !== 'resolved') {
                    return errorResponse('SCM hosting provider does not support pull request creation', SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
                }
                const nextAction = createValidatedPullRequestFollowupAction({
                    provider: resolvedProvider,
                    purpose: 'compose',
                    url: compareUrl.url,
                    allowedBaseUrl: resolvedProvider.baseUrl,
                });
                return {
                    success: false,
                    errorCode,
                    error: 'Complete pull request creation on the provider page.',
                    result: 'opened_compose',
                    outcome: {
                        v: 1, kind: 'needs_input', errorCode,
                        nextActions: nextAction.kind === 'openUrl' ? [{ kind: 'open_url', url: nextAction.url }] : [],
                    },
                    pullRequest: null,
                    reused: false,
                    composeUrl: compareUrl.url,
                    nextAction,
                    authState: 'authentication_required',
                };
            }

            if (!writeAdapter?.createPullRequest || (request.draft === true && writeAdapter.supportsDraftCreate !== true)) {
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
                    const currentCacheKey = readCurrentCacheKey();
                    if (currentCacheKey) {
                        cache.setSuccess({ key: currentCacheKey, pullRequests: [existing] });
                    }
                    return createSuccessfulResponse({ pullRequest: existing, provider: resolvedProvider, reused: true });
                }
            } catch (error) {
                const classified = classifyHostingProviderError(error);
                if (authProfileKey) {
                    cache.setError({
                        key: cacheKey,
                        error: classified.message,
                        errorCode: classified.code,
                        errorKind: classified.cacheKind,
                    });
                }
                if (classified.code === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED || classified.code === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
                    return composeFallback(classified.code);
                }
                return errorResponse(classified.message, classified.code, classified.details);
            }

            let body = request.body;
            if (body === undefined) {
                const template = await readPullRequestTemplate({
                    cwd: snapshot.repo.rootPath ?? context.cwd,
                    base: resolvedBaseBranch,
                    remoteName: resolvedProvider.remoteName,
                    providerKind: resolvedProvider.kind,
                });
                if (template.kind === 'needs_input') {
                    return errorResponse(template.error, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, {
                        outcome: { v: 1, kind: 'needs_input', errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, nextActions: [] },
                    });
                }
                body = template.body;
            }

            const unknownCreateOutcome = (message: string, errorCode: ScmOperationErrorCode,
                details?: ReturnType<typeof classifyHostingProviderError>['details']) => errorResponse(message, errorCode, {
                ...details,
                outcome: {
                    v: 1, kind: 'outcome_unknown', errorCode, nextActions: [],
                    reconciliation: {
                        kind: 'pull_request', providerId: resolvedProvider.id,
                        ...(resolvedProvider.nameWithOwner ? { repository: resolvedProvider.nameWithOwner } : {}),
                        head: resolvedHeadBranch, base: resolvedBaseBranch,
                    },
                },
            });

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
                    ...(body !== undefined ? { body } : {}),
                    ...(request.draft !== undefined ? { draft: request.draft } : {}),
                    runtimeServices: readRuntimeServices(),
                });
                if (!matchesBranchHeadContext({
                    pullRequest: created,
                    provider: resolvedProvider,
                    baseBranch: resolvedBaseBranch,
                    headBranch: resolvedHeadBranch,
                    ...(requestedHeadRepositoryNameWithOwner ? { headRepositoryNameWithOwner: requestedHeadRepositoryNameWithOwner } : {}),
                })) {
                    return unknownCreateOutcome(
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
                const currentCacheKey = readCurrentCacheKey();
                if (currentCacheKey) {
                    cache.setSuccess({ key: currentCacheKey, pullRequests: [created] });
                }
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
                    const currentCacheKey = readCurrentCacheKey();
                    if (currentCacheKey) {
                        cache.setSuccess({ key: currentCacheKey, pullRequests: [duplicateHint] });
                    }
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
                    const currentCacheKey = readCurrentCacheKey();
                    if (currentCacheKey) {
                        cache.setSuccess({ key: currentCacheKey, pullRequests: [listedAfterDuplicate] });
                    }
                    return createSuccessfulResponse({ pullRequest: listedAfterDuplicate, provider: resolvedProvider, reused: true });
                }
                const classified = classifyHostingProviderError(error);
                if (classified.code === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED || classified.code === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
                    return composeFallback(classified.code);
                }
                const effectNotApplied = typeof error === 'object' && error !== null
                    && 'effectNotApplied' in error && error.effectNotApplied === true;
                return effectNotApplied
                    ? errorResponse(classified.message, classified.code, classified.details)
                    : unknownCreateOutcome(classified.message, classified.code, classified.details);
            }
        },
    });
}

const gitPullRequestOpenOrReuseOperation = createGitPullRequestOpenOrReuseOperation();

export const gitPullRequestOpenOrReuse = gitPullRequestOpenOrReuseOperation.openOrReuse;
