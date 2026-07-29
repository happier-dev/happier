import { createScmBackendCatalog as createBuiltInScmBackendCatalog } from './providers/catalog';
import { createScmBackendRegistry, type ScmBackendRegistry } from './registry';
import type { ScmBackend } from './types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createPluginScmBackendsFromRuntimeRegistry,
    type ScmBackendPluginRuntimeRegistry,
} from './pluginBackends/runtimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

export function createScmBackendCatalogWithPlugins(input?: Readonly<{
    pluginBackends?: readonly ScmBackend[];
    pluginRuntimeRegistry?: ScmBackendPluginRuntimeRegistry;
}>): readonly ScmBackend[] {
    const pluginRuntimeBackends = input?.pluginRuntimeRegistry
        ? createPluginScmBackendsFromRuntimeRegistry(input.pluginRuntimeRegistry)
        : [];

    return Object.freeze([
        ...createBuiltInScmBackendCatalog(),
        ...(input?.pluginBackends ?? []),
        ...pluginRuntimeBackends,
    ]);
}

export { createScmBackendCatalogWithPlugins as createScmBackendCatalog };

export async function activateScmRuntimeContributionsOnDemand(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry & Pick<
        ResolvedExecutablePluginRuntimeRegistry,
        'activateContributionsOnDemand'
    >,
): Promise<void> {
    const hostingProviderDemands = (runtimeRegistry.contributes.scmHostingProviders ?? []).flatMap((contribution) => (
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
}>): Promise<ScmBackendRegistry> {
    await activateScmRuntimeContributionsOnDemand(input.pluginRuntimeRegistry);
    return createScmBackendRegistry(createScmBackendCatalogWithPlugins({
        pluginRuntimeRegistry: input.pluginRuntimeRegistry,
    }));
}

export async function runWithScmBackendRegistryLease<T>(
    registry: ScmBackendRegistry | undefined,
    run: (registry: ScmBackendRegistry) => Promise<T>,
    input?: Readonly<{ happyHomeDir?: string }>,
): Promise<T> {
    if (registry) {
        return await run(registry);
    }

    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: input?.happyHomeDir,
    });
    try {
        await activateScmRuntimeContributionsOnDemand(lease.registry);
        const resolvedRegistry = createScmBackendRegistry(createScmBackendCatalogWithPlugins({
            pluginRuntimeRegistry: lease.registry,
        }));
        return await run(resolvedRegistry);
    } finally {
        await lease.release();
    }
}
