import type { ResolvedScmHostingProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createScmHostingProviderRegistry, type ResolvedScmHostingProviderRegistry } from './registry';

type HostRegistryInput = Readonly<{
    contributes: Readonly<{ scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[] }>;
    scmHostingProvidersById: ResolvedExecutablePluginRuntimeRegistry['scmHostingProvidersById'];
}>;

/** One composition of admitted hosting declarations and runtime capabilities. */
export function createHostScmHostingProviderRegistry(
    input: HostRegistryInput,
    options: Omit<Parameters<typeof createScmHostingProviderRegistry>[0], 'providers' | 'runtimeRegistrations'> = {},
): ResolvedScmHostingProviderRegistry {
    return createScmHostingProviderRegistry({
        ...options,
        providers: (input.contributes.scmHostingProviders ?? []).map(provider => {
            const { title, ...definition } = provider.definition;
            return Object.freeze({
                ...definition,
                displayName: typeof title === 'string' ? title : title.fallback,
                pluginId: provider.pluginId,
                urlSafety: { allowedSchemes: ['https:'], allowedBaseUrls: [], allowedOrigins: [] },
            });
        }),
        runtimeRegistrations: [...input.scmHostingProvidersById.values()].map(entry => ({
            pluginId: entry.pluginId,
            occurrenceId: entry.occurrenceId,
            registration: entry.registration,
        })),
    });
}

/** Capability discovery needs neither configured account deployments nor a provider request. */
export function listPublishCapableForgesV1(input: HostRegistryInput): Array<Readonly<{ providerKind: string; title: string }>> {
    const registry = createHostScmHostingProviderRegistry(input);
    const forges = new Map<string, Readonly<{ providerKind: string; title: string }>>();
    for (const provider of registry.providers) {
        if (!registry.getRepositoryPublishing(provider.id) || forges.has(provider.kind)) continue;
        forges.set(provider.kind, { providerKind: provider.kind, title: provider.displayName });
    }
    return [...forges.values()];
}
