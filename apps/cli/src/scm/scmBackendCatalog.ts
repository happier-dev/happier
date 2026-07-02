import { createScmBackendCatalog as createBuiltInScmBackendCatalog } from './providers/catalog';
import { createScmBackendRegistry, type ScmBackendRegistry } from './registry';
import type { ScmBackend } from './types';
import {
    createRegisteredScmBackendRegistry,
    type RegisteredScmBackendActivation,
    type RegisteredScmBackendDefinition,
} from './pluginBackends/registeredScmBackendRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedScmBackendContribution } from '@/plugins/projection/registry/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { createHostScmHostingProviderRuntimeServices } from './hostingProviders/runtimeServices';

export type ScmBackendPluginRuntimeRegistry = Readonly<{
    contributes: Readonly<{
        scmBackends?: readonly ResolvedScmBackendContribution[];
        scmHostingProviders?: ResolvedExecutablePluginRuntimeRegistry['contributes']['scmHostingProviders'];
        connectedAccountDescriptors?: ResolvedExecutablePluginRuntimeRegistry['contributes']['connectedAccountDescriptors'];
    }>;
    scmHostingProvidersById?: ResolvedExecutablePluginRuntimeRegistry['scmHostingProvidersById'];
    scmBackendsById?: ResolvedExecutablePluginRuntimeRegistry['scmBackendsById'];
    scmBackendRegistrations?: ResolvedExecutablePluginRuntimeRegistry['scmBackendRegistrations'];
}>;

export function createPluginScmBackendsFromRuntimeRegistry(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry,
): readonly ScmBackend[] {
    return createPluginScmBackendRegistryFromRuntimeRegistry(runtimeRegistry).backends;
}

export function createPluginScmBackendRegistryFromRuntimeRegistry(
    runtimeRegistry: ScmBackendPluginRuntimeRegistry,
): Readonly<{
    backends: readonly ScmBackend[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const definitions: RegisteredScmBackendDefinition[] = (runtimeRegistry.contributes.scmBackends ?? [])
        .flatMap((entry) => {
            if (!entry.pluginId) {
                return [];
            }
            return [{
                pluginId: entry.pluginId,
                contributionId: entry.definition.id,
                definition: entry.definition,
            }];
        });
    const activationEntries = runtimeRegistry.scmBackendRegistrations
        ?? [...(runtimeRegistry.scmBackendsById ?? new Map()).values()];
    const registrations: RegisteredScmBackendActivation[] = activationEntries
        .map((entry) => ({
            pluginId: entry.pluginId,
            registration: entry.registration,
        }));

    return createRegisteredScmBackendRegistry({
        definitions,
        registrations,
        hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({
            contributes: runtimeRegistry.contributes,
            scmHostingProvidersById: runtimeRegistry.scmHostingProvidersById ?? new Map(),
        }),
    });
}

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

export async function resolveDefaultScmBackendRegistry(input?: Readonly<{
    happyHomeDir?: string;
    pluginRuntimeRegistry?: ScmBackendPluginRuntimeRegistry;
}>): Promise<ScmBackendRegistry> {
    const pluginRuntimeRegistry = input?.pluginRuntimeRegistry
        ?? await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry')
            .then(({ resolveExecutablePluginRuntimeRegistry }) => resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: input?.happyHomeDir,
            }));

    return createScmBackendRegistry(createScmBackendCatalogWithPlugins({
        pluginRuntimeRegistry,
    }));
}

export async function resolveScmBackendRegistry(
    registry?: ScmBackendRegistry,
): Promise<ScmBackendRegistry> {
    return registry ?? await resolveDefaultScmBackendRegistry();
}
