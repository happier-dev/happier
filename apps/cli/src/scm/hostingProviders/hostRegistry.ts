import type { ResolvedScmHostingProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createScmHostingProviderRegistry, type ResolvedScmHostingProviderRegistry } from './registry';
import { ScmHostingProviderKindSchema } from '@happier-dev/protocol/scm/pullRequests';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

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

/**
 * Capability discovery needs neither configured account deployments nor a provider request. Only a canonical hosting
 * kind is offered: describing and creating the repository take that kind, so a plugin's own kind has no publish path.
 */
export function listPublishCapableForgesV1(input: HostRegistryInput): DeploySuggestionCatalogV1['forges'] {
    const registry = createHostScmHostingProviderRegistry(input);
    const forges = new Map<string, DeploySuggestionCatalogV1['forges'][number]>();
    for (const provider of registry.providers) {
        const kind = ScmHostingProviderKindSchema.safeParse(provider.kind);
        if (!kind.success || !registry.getRepositoryPublishing(provider.id) || forges.has(kind.data)) continue;
        forges.set(kind.data, { providerKind: kind.data, title: provider.displayName });
    }
    return [...forges.values()];
}
