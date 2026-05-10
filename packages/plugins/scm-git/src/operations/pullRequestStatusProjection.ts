import {
    type ScmHostingProviderRef,
    type ScmPullRequestAuthState,
    type ScmPullRequestStatusProjection,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import { readCurrentScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';

import { createScmHostingProviderRegistry } from '../hostingProviders/registry.js';
import { defaultPrStatusCache, type PrStatusCache } from '../hostingProviders/prStatusCache.js';
import type {
    ResolvedScmHostingProviderRegistry,
    ScmHostingProviderDescriptor,
} from '../hostingProviders/types.js';

export type PullRequestStatusProjectionRegistry = Pick<ResolvedScmHostingProviderRegistry, 'detectRemote' | 'buildCompareUrl'>;

let defaultRegistryPromise: Promise<ResolvedScmHostingProviderRegistry> | null = null;

function normalizeUrlSafety(
    provider: ScmHostingProviderDescriptor,
): ScmHostingProviderDescriptor['urlSafety'] {
    return {
        allowedSchemes: provider.urlSafety?.allowedSchemes ?? ['https:'],
        allowedBaseUrls: provider.urlSafety?.allowedBaseUrls ?? [],
        allowedOrigins: provider.urlSafety?.allowedOrigins ?? [],
    };
}

export function createPullRequestStatusProjectionRegistry(
    runtimeRegistry: Readonly<{
        contributes: Readonly<{
            scmHostingProviders?: readonly Readonly<{
                pluginId: string;
                definition: ScmHostingProviderDescriptor;
            }>[];
        }>;
        scmHostingProvidersById: ReadonlyMap<string, Readonly<{
            pluginId: string;
            registration: Readonly<{
                id: string;
                adapter: Readonly<Record<string, unknown>>;
            }>;
        }>>;
    }>,
): ResolvedScmHostingProviderRegistry {
    const providers: ScmHostingProviderDescriptor[] = (runtimeRegistry.contributes.scmHostingProviders ?? [])
        .map((provider) => Object.freeze({
            ...provider.definition,
            pluginId: provider.pluginId,
            urlSafety: normalizeUrlSafety(provider.definition),
        }));

    return createScmHostingProviderRegistry({
        providers,
        runtimeRegistrations: [...runtimeRegistry.scmHostingProvidersById.values()],
    });
}

export async function resolveDefaultPullRequestStatusProjectionRegistry(): Promise<ResolvedScmHostingProviderRegistry> {
    const currentServices = readCurrentScmHostingProviderRuntimeServices();
    const currentRegistry = await currentServices?.resolveScmHostingProviderRegistry?.();
    if (currentRegistry) {
        return currentRegistry as ResolvedScmHostingProviderRegistry;
    }
    defaultRegistryPromise ??= Promise.resolve(createScmHostingProviderRegistry({
        providers: [],
        runtimeRegistrations: [],
    }));
    return await defaultRegistryPromise;
}

function readRemoteUrl(remote: ScmWorkingSnapshot['repo']['remotes'][number]): string | null {
    return remote.pushUrl ?? remote.fetchUrl ?? null;
}

function selectHostingProvider(
    snapshot: ScmWorkingSnapshot,
    registry: PullRequestStatusProjectionRegistry,
): ScmHostingProviderRef | null {
    const remotes = snapshot.repo.remotes;
    const orderedRemotes = [
        ...remotes.filter((remote) => remote.name === 'origin'),
        ...remotes.filter((remote) => remote.name !== 'origin'),
    ];
    for (const remote of orderedRemotes) {
        const remoteUrl = readRemoteUrl(remote);
        if (!remoteUrl) continue;
        const detected = registry.detectRemote({
            remoteName: remote.name,
            remoteUrl,
        });
        if (detected.kind === 'resolved') {
            return detected.provider as ScmHostingProviderRef;
        }
    }
    return null;
}

function normalizeUpstreamBranch(upstream: string | null): string | null {
    if (!upstream) return null;
    const slashIndex = upstream.indexOf('/');
    if (slashIndex < 0) return upstream;
    return upstream.slice(slashIndex + 1) || null;
}

function resolvePullRequestBaseBranch(snapshot: ScmWorkingSnapshot): string | null {
    return snapshot.repo.defaultBranch?.trim()
        ?? normalizeUpstreamBranch(snapshot.branch.upstream)
        ?? null;
}

function readAuthState(entry: ReturnType<PrStatusCache['getFreshForAnyAuthProfile']>): ScmPullRequestAuthState {
    if (!entry) return 'unknown';
    if (entry.kind === 'success') return 'authenticated';
    if (entry.errorKind === 'auth') return 'authentication_required';
    return 'unknown';
}

export function projectPullRequestStatus(input: Readonly<{
    snapshot: ScmWorkingSnapshot;
    registry: PullRequestStatusProjectionRegistry;
    cache?: PrStatusCache;
    now?: () => number;
}>): ScmWorkingSnapshot {
    const snapshot = input.snapshot;
    const registry = input.registry;
    const cache = input.cache ?? defaultPrStatusCache;
    const headBranch = snapshot.branch.head;
    const baseBranch = resolvePullRequestBaseBranch(snapshot);
    const provider = selectHostingProvider(snapshot, registry);

    if (!provider || !headBranch) {
        return {
            ...snapshot,
            hostingProvider: provider,
            pullRequestStatus: {
                provider,
                headBranch,
                baseBranch,
                openPullRequest: null,
                authState: provider ? 'unknown' : 'unsupported',
                checkedAt: input.now?.() ?? Date.now(),
            },
        };
    }

    const cached = cache.getFreshForAnyAuthProfile({
        workspaceKey: snapshot.projectKey,
        repoRootPath: snapshot.repo.rootPath ?? snapshot.projectKey,
        provider,
        baseBranch,
        headBranch,
        state: 'open',
    });
    const compareUrl = baseBranch
        ? registry.buildCompareUrl({ provider, base: baseBranch, head: headBranch })
        : { kind: 'unsupported' as const };
    const openPullRequest = cached?.kind === 'success'
        ? cached.pullRequests.find((pr) => pr.headBranch === headBranch && pr.state === 'open') ?? null
        : null;
    const pullRequestStatus: ScmPullRequestStatusProjection = {
        provider,
        headBranch,
        baseBranch,
        openPullRequest,
        composeUrl: compareUrl.kind === 'resolved' ? compareUrl.url : null,
        authState: readAuthState(cached),
        checkedAt: cached?.fetchedAt ?? input.now?.() ?? Date.now(),
        cacheTtlMs: cached ? Math.max(0, cached.expiresAt - (input.now?.() ?? Date.now())) : undefined,
    };

    return {
        ...snapshot,
        hostingProvider: provider,
        pullRequestStatus,
    };
}
