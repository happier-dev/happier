import { createScmBackendCatalog as createBuiltInScmBackendCatalog } from './providers/catalog';
import { createScmBackendRegistry, type ScmBackendRegistry } from './registry';
import type { ScmBackend } from './types';
import {
    activateScmProviderRuntimeEvents,
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

export const defaultScmBackendRegistry: ScmBackendRegistry = createScmBackendRegistry(createScmBackendCatalogWithPlugins());

export function resolveScmRuntimePluginIds(contributes: Readonly<{
    activationTargets?: readonly Readonly<{ pluginId: string }>[];
    scmBackends?: readonly Readonly<{ pluginId?: string }>[];
    scmHostingProviders?: readonly Readonly<{ pluginId?: string }>[];
}>): readonly string[] {
    const activationTargetPluginIds = new Set((contributes.activationTargets ?? []).map((target) => target.pluginId));
    const pluginIds = new Set<string>();

    for (const contribution of [
        ...(contributes.scmBackends ?? []),
        ...(contributes.scmHostingProviders ?? []),
    ]) {
        if (contribution.pluginId && activationTargetPluginIds.has(contribution.pluginId)) {
            pluginIds.add(contribution.pluginId);
        }
    }

    return Object.freeze([...pluginIds].sort());
}

export async function resolveDefaultScmBackendRegistry(input?: Readonly<{
    happyHomeDir?: string;
    pluginRuntimeRegistry?: ScmBackendPluginRuntimeRegistry;
}>): Promise<ScmBackendRegistry> {
    if (input?.pluginRuntimeRegistry) {
        await activateScmProviderRuntimeEvents(input.pluginRuntimeRegistry);
        return createScmBackendRegistry(createScmBackendCatalogWithPlugins({
            pluginRuntimeRegistry: input.pluginRuntimeRegistry,
        }));
    }

    if (!input?.happyHomeDir) {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
        try {
            await activateScmProviderRuntimeEvents(lease.registry);
            return createScmBackendRegistry(createScmBackendCatalogWithPlugins({
                pluginRuntimeRegistry: lease.registry,
            }));
        } finally {
            await lease.release();
        }
    }

    const pluginRuntimeRegistry = await (async () => {
        const { resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
        const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
        const contributes = await resolveMergedContributionRegistry({
            happyHomeDir: input?.happyHomeDir,
        });

        return await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: input?.happyHomeDir,
            contributes,
            pluginIds: resolveScmRuntimePluginIds(contributes),
        });
    })();

    return createScmBackendRegistry(createScmBackendCatalogWithPlugins({
        pluginRuntimeRegistry,
    }));
}

export async function resolveScmBackendRegistry(
    registry?: ScmBackendRegistry,
): Promise<ScmBackendRegistry> {
    return registry ?? await resolveDefaultScmBackendRegistry();
}
