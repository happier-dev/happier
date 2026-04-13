import type { AgentCatalogEntry, CatalogAgentId } from '@/backends/types';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import { resolvePluginContributions } from './resolvePluginContributions';
import type {
    ResolvedBackendContribution,
    ResolvedBackendRuntimeAdapterContribution,
    ResolvedContributionInputs,
    ResolvedContributionRegistry,
    ResolvedCatalogEntry,
    ResolvedProviderContribution,
} from './types';

export function createResolvedContributionRegistry(inputs: ResolvedContributionInputs): ResolvedContributionRegistry {
    const providerDefinitionsById = new Map<string, ResolvedProviderContribution>();
    const backendDefinitionsById = new Map<string, ResolvedBackendContribution>();
    const runtimeAdaptersByBackendId = new Map<string, readonly ResolvedBackendRuntimeAdapterContribution[]>();
    const catalogEntriesById: Record<string, ResolvedCatalogEntry> = {};

    for (const provider of inputs.providers) {
        assertProviderContributionAligned(provider);
        if (providerDefinitionsById.has(provider.id)) {
            throw new Error(`Duplicate provider contribution '${provider.id}'`);
        }

        providerDefinitionsById.set(provider.id, provider);

        if (provider.catalogEntry) {
            catalogEntriesById[provider.id] = provider.catalogEntry;
        }
    }

    for (const backend of inputs.backends) {
        assertBackendContributionAligned(backend);
        if (backendDefinitionsById.has(backend.id)) {
            throw new Error(`Duplicate backend contribution '${backend.id}'`);
        }
        if (!providerDefinitionsById.has(backend.providerId)) {
            throw new Error(`Missing provider contribution '${backend.providerId}' for backend '${backend.id}'`);
        }

        backendDefinitionsById.set(backend.id, backend);

        const runtimeAdapters = backend.runtimeAdapters ?? [];
        if (runtimeAdapters.length > 0) {
            runtimeAdaptersByBackendId.set(
                backend.id,
                Object.freeze(runtimeAdapters.map((definition) => ({
                    backendId: backend.id,
                    source: backend.source,
                    definition,
                    pluginId: backend.pluginId,
                    manifestPath: backend.manifestPath,
                    manifestDigest: backend.manifestDigest,
                    daemonEntryPath: backend.daemonEntryPath,
                }))),
            );
        }
    }

    return Object.freeze({
        providers: inputs.providers,
        backends: inputs.backends,
        hookRegistrations: Object.freeze([...(inputs.hookRegistrations ?? [])]),
        runtimeAdaptersByBackendId: Object.freeze(runtimeAdaptersByBackendId),
        catalogEntriesById: Object.freeze(catalogEntriesById),
        providerDefinitionsById,
        backendDefinitionsById,
        pluginDiagnosticsByPluginId: Object.freeze({ ...(inputs.pluginDiagnosticsByPluginId ?? {}) }),
    });
}

let cachedResolvedContributionRegistry: ResolvedContributionRegistry | null = null;

export function getResolvedContributionRegistry(): ResolvedContributionRegistry {
    if (cachedResolvedContributionRegistry) {
        return cachedResolvedContributionRegistry;
    }

    cachedResolvedContributionRegistry = createResolvedContributionRegistry(resolveBuiltInContributions());
    return cachedResolvedContributionRegistry;
}

export async function resolveMergedContributionRegistry(
    params?: Readonly<{ happyHomeDir?: string }>,
): Promise<ResolvedContributionRegistry> {
    const builtIn = resolveBuiltInContributions();
    const plugin = await resolvePluginContributions({
        happyHomeDir: params?.happyHomeDir,
        existingProviderIds: new Set(builtIn.providers.map((provider) => provider.id)),
        existingBackendIds: new Set(builtIn.backends.map((backend) => backend.id)),
    });

    return createResolvedContributionRegistry({
        providers: Object.freeze([...builtIn.providers, ...plugin.providers]),
        backends: Object.freeze([...builtIn.backends, ...plugin.backends]),
        hookRegistrations: Object.freeze([...(builtIn.hookRegistrations ?? []), ...(plugin.hookRegistrations ?? [])]),
        pluginDiagnosticsByPluginId: Object.freeze({
            ...(builtIn.pluginDiagnosticsByPluginId ?? {}),
            ...(plugin.pluginDiagnosticsByPluginId ?? {}),
        }),
    });
}

function assertProviderContributionAligned(provider: ResolvedProviderContribution): void {
    if (provider.definition.kindVersion !== 1) {
        throw new Error(`Provider definition version mismatch for contribution '${provider.id}'`);
    }
    if (provider.definition.id !== provider.id) {
        throw new Error(`Provider definition id mismatch for contribution '${provider.id}'`);
    }
    if (provider.catalogEntry && provider.catalogEntry.id !== provider.id) {
        throw new Error(`Catalog entry id mismatch for provider contribution '${provider.id}'`);
    }
    if (provider.catalogEntry && provider.catalogEntry.cliSubcommand !== provider.id) {
        throw new Error(`Catalog entry cliSubcommand mismatch for provider contribution '${provider.id}'`);
    }
}

function assertBackendContributionAligned(backend: ResolvedBackendContribution): void {
    if (backend.definition.kindVersion !== 1) {
        throw new Error(`Backend definition version mismatch for contribution '${backend.id}'`);
    }
    if (backend.definition.id !== backend.id) {
        throw new Error(`Backend definition id mismatch for contribution '${backend.id}'`);
    }
    if (backend.definition.providerId !== backend.providerId) {
        throw new Error(`Backend provider id mismatch for contribution '${backend.id}'`);
    }
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
    return getResolvedContributionRegistry().catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}
