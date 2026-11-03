import { createScmBackendRegistry, type ScmBackendRegistry } from './registry';
import type { ScmBackend } from './types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createPluginScmBackendsFromRuntimeRegistry,
    type ScmBackendPluginRuntimeRegistry,
} from './pluginBackends/runtimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

function createScmBackendCatalogWithPlugins(input: Readonly<{
    pluginRuntimeRegistry: ScmBackendPluginRuntimeRegistry;
    includeHostingProviders?: boolean;
}>): readonly ScmBackend[] {
    const runtimeRegistry = input.pluginRuntimeRegistry;
    // Local review needs repository facts, not forge deployment/account discovery.
    const localRuntimeRegistry = input.includeHostingProviders === false ? {
        ...runtimeRegistry,
        contributes: { ...runtimeRegistry.contributes, scmHostingProviders: [] },
        scmHostingProvidersById: new Map<never, never>(),
    } : runtimeRegistry;
    return Object.freeze([...createPluginScmBackendsFromRuntimeRegistry(localRuntimeRegistry)]);
}

export async function activateScmRuntimeContributionsOnDemand(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry & Pick<
        ResolvedExecutablePluginRuntimeRegistry,
        'activateContributionsOnDemand'
    >,
    includeHostingProviders = true,
): Promise<void> {
    const hostingProviderDemands = (includeHostingProviders ? runtimeRegistry.contributes.scmHostingProviders ?? [] : []).flatMap((contribution) => (
        contribution.pluginId
            ? [{
                pluginId: contribution.pluginId,
                family: 'scmHostingProviders' as const,
                localId: contribution.definition.id,
            }]
            : []
    ));
    if (hostingProviderDemands.length > 0) {
        await runtimeRegistry.activateContributionsOnDemand(hostingProviderDemands);
    }

    const backendDemands = (runtimeRegistry.contributes.scmBackends ?? []).flatMap((contribution) => (
        contribution.pluginId
            ? [{
                pluginId: contribution.pluginId,
                family: 'scmBackends' as const,
                localId: contribution.definition.id,
            }]
            : []
    ));
    if (backendDemands.length > 0) {
        await runtimeRegistry.activateContributionsOnDemand(backendDemands);
    }
}

export async function resolveDefaultScmBackendRegistry(input: Readonly<{
    pluginRuntimeRegistry: ScmBackendPluginRuntimeRegistry & Pick<
        ResolvedExecutablePluginRuntimeRegistry,
        'activateContributionsOnDemand'
    >;
    /** Omit optional forge activation and deployment discovery for local-only reads. */
    includeHostingProviders?: boolean;
}>): Promise<ScmBackendRegistry> {
    await activateScmRuntimeContributionsOnDemand(input.pluginRuntimeRegistry, input.includeHostingProviders);
    return createScmBackendRegistry(createScmBackendCatalogWithPlugins({
        pluginRuntimeRegistry: input.pluginRuntimeRegistry,
        includeHostingProviders: input.includeHostingProviders,
    }));
}

export async function runWithScmBackendRegistryLease<T>(
    registry: ScmBackendRegistry | undefined,
    run: (registry: ScmBackendRegistry) => Promise<T>,
    input?: Readonly<{ happyHomeDir?: string; includeHostingProviders?: boolean }>,
): Promise<T> {
    if (registry) {
        return await run(registry);
    }

    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: input?.happyHomeDir,
    });
    try {
        const resolvedRegistry = await resolveDefaultScmBackendRegistry({
            pluginRuntimeRegistry: lease.registry,
            includeHostingProviders: input?.includeHostingProviders,
        });
        return await run(resolvedRegistry);
    } finally {
        await lease.release();
    }
}
