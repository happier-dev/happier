import type { BackendRuntimeAdapterV1, ProviderDefinitionV1 } from '@happier-dev/protocol';
import type {
    BackendDefinitionContractV1,
    ProviderDefinitionContractV1,
} from '@happier-dev/agents';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';

import { buildPluginContributionRegistry } from '@/extensions/plugins/loader/buildPluginContributionRegistry';
import { loadInstalledPlugins } from '@/extensions/plugins/loader/loadInstalledPlugins';
import type { PluginCompatibilityDiagnostic } from '@/extensions/plugins/shared/pluginDiagnostics';

import type {
    ResolvedBackendContribution,
    ResolvedCatalogEntry,
    ResolvedContributionInputs,
    ResolvedHookRegistration,
    ResolvedProviderContribution,
} from './types';

type ResolvePluginContributionsParams = Readonly<{
    happyHomeDir?: string;
    existingProviderIds?: ReadonlySet<string>;
    existingBackendIds?: ReadonlySet<string>;
}>;

type PluginResolvedProviderContribution = ResolvedProviderContribution & Readonly<{
    source: 'plugin';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedBackendContribution = ResolvedBackendContribution & Readonly<{
    source: 'plugin';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    runtimeAdapters: readonly BackendRuntimeAdapterV1[];
}>;

function appendDiagnostic(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string,
    diagnostic: PluginCompatibilityDiagnostic,
): void {
    const existing = diagnosticsByPluginId[pluginId];
    if (existing) {
        existing.push(diagnostic);
        return;
    }
    diagnosticsByPluginId[pluginId] = [diagnostic];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPluginCatalogEntry(params: Readonly<{
    pluginId: string;
    providerId: string;
    definition: ProviderDefinitionV1;
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
}>): ResolvedCatalogEntry | null {
    const rawProvider = params.definition as Record<string, unknown>;
    const rawCatalogEntry = rawProvider.catalogEntry;
    if (rawCatalogEntry === undefined || rawCatalogEntry === null) {
        return null;
    }
    if (!isRecord(rawCatalogEntry)) {
        appendDiagnostic(params.diagnosticsByPluginId, params.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${params.providerId}' has a non-object catalogEntry`,
        });
        return null;
    }

    const entryId = typeof rawCatalogEntry.id === 'string' ? rawCatalogEntry.id.trim() : '';
    const cliSubcommand = typeof rawCatalogEntry.cliSubcommand === 'string' ? rawCatalogEntry.cliSubcommand.trim() : '';
    if (entryId.length === 0 || cliSubcommand.length === 0) {
        appendDiagnostic(params.diagnosticsByPluginId, params.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${params.providerId}' catalogEntry requires non-empty id and cliSubcommand`,
        });
        return null;
    }
    if (entryId !== params.providerId || cliSubcommand !== params.providerId) {
        appendDiagnostic(params.diagnosticsByPluginId, params.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${params.providerId}' catalogEntry id/cliSubcommand must both match the provider id`,
        });
        return null;
    }

    const rawVendorResumeSupport = rawCatalogEntry.vendorResumeSupport;
    const vendorResumeSupport = rawVendorResumeSupport === 'supported'
        || rawVendorResumeSupport === 'experimental'
        || rawVendorResumeSupport === 'unsupported'
        ? rawVendorResumeSupport
        : 'unsupported';

    return {
        id: entryId,
        cliSubcommand,
        vendorResumeSupport,
    };
}

function readPluginProviderCliRuntime(
    pluginId: string,
    providerId: string,
    definition: ProviderDefinitionV1,
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
): ProviderCliRuntimeDescriptor | null {
    const runtime = definition.providerCliRuntime;
    if (!runtime) {
        return null;
    }
    if (runtime.id !== providerId) {
        appendDiagnostic(diagnosticsByPluginId, pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${providerId}' providerCliRuntime id must match the provider id`,
        });
        return null;
    }
    return {
        ...runtime,
        id: runtime.id,
    };
}

export async function resolvePluginContributions(
    params: ResolvePluginContributionsParams = {},
): Promise<ResolvedContributionInputs> {
    const loadResult = await loadInstalledPlugins({ happyHomeDir: params.happyHomeDir });
    const pluginRegistry = buildPluginContributionRegistry({ loadedPlugins: loadResult.loadedPlugins });
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const knownProviderIds = new Set(params.existingProviderIds ?? []);
    const knownBackendIds = new Set(params.existingBackendIds ?? []);
    const providerCandidates: PluginResolvedProviderContribution[] = [];
    const backendCandidates: PluginResolvedBackendContribution[] = [];
    const hookRegistrations: ResolvedHookRegistration[] = [];

    for (const [pluginId, diagnostics] of Object.entries(loadResult.diagnosticsByPluginId)) {
        diagnosticsByPluginId[pluginId] = [...diagnostics];
    }

    for (const contribution of pluginRegistry.providers) {
        if (knownProviderIds.has(contribution.definition.id)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin provider '${contribution.definition.id}' collides with an existing provider id`,
            });
            continue;
        }

        knownProviderIds.add(contribution.definition.id);
        const catalogEntry = readPluginCatalogEntry({
            pluginId: contribution.pluginId,
            providerId: contribution.definition.id,
            definition: contribution.definition,
            diagnosticsByPluginId,
        });
        const runtimeSpec = readPluginProviderCliRuntime(
            contribution.pluginId,
            contribution.definition.id,
            contribution.definition,
            diagnosticsByPluginId,
        );
        providerCandidates.push({
            id: contribution.definition.id,
            source: 'plugin',
            definition: Object.freeze({
                kindVersion: 1,
                id: contribution.definition.id,
                ownedBackendIds: Object.freeze([...contribution.definition.ownedBackendIds]),
            }) satisfies ProviderDefinitionContractV1,
            runtimeSpec,
            catalogEntry,
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
        });
    }

    for (const contribution of pluginRegistry.backends) {
        if (knownBackendIds.has(contribution.definition.id)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin backend '${contribution.definition.id}' collides with an existing backend id`,
            });
            continue;
        }

        if (!knownProviderIds.has(contribution.definition.providerId)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin backend '${contribution.definition.id}' references missing provider '${contribution.definition.providerId}'`,
            });
            continue;
        }

        knownBackendIds.add(contribution.definition.id);
        backendCandidates.push({
            id: contribution.definition.id,
            providerId: contribution.definition.providerId,
            source: 'plugin',
            definition: Object.freeze({
                kindVersion: 1,
                id: contribution.definition.id,
                providerId: contribution.definition.providerId,
            }) satisfies BackendDefinitionContractV1,
            runtimeAdapters: Object.freeze([...contribution.definition.runtimeAdapters]),
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
        });
    }

    const availableBackendProviderIds = new Map<string, string>();
    for (const backend of backendCandidates) {
        availableBackendProviderIds.set(backend.id, backend.providerId);
    }

    const invalidProviderIds = new Set<string>();
    for (const provider of providerCandidates) {
        const ownedBackendIds = provider.definition.ownedBackendIds;
        const hasInvalidOwnedBackend = ownedBackendIds.some((backendId) => {
            const ownerProviderId = availableBackendProviderIds.get(backendId);
            return ownerProviderId === undefined || ownerProviderId !== provider.id;
        });

        if (!hasInvalidOwnedBackend) {
            continue;
        }

        invalidProviderIds.add(provider.id);
        appendDiagnostic(diagnosticsByPluginId, provider.pluginId ?? provider.id, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${provider.id}' declares owned backend ids that do not resolve to that provider`,
        });
    }

    const providers = providerCandidates.filter((provider) => !invalidProviderIds.has(provider.id));
    const backends = backendCandidates.filter((backend) => {
        if (!invalidProviderIds.has(backend.providerId)) {
            return true;
        }

        appendDiagnostic(diagnosticsByPluginId, backend.pluginId ?? backend.id, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin backend '${backend.id}' is excluded because provider '${backend.providerId}' is invalid`,
        });
        return false;
    });

    for (const contribution of pluginRegistry.hooks) {
        if (!contribution.daemonEntryPath) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin hook '${contribution.definition.id}' requires a daemon entry target`,
            });
            continue;
        }

        hookRegistrations.push({
            source: 'plugin',
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            definition: contribution.definition,
        });
    }

    return {
        providers: Object.freeze(providers),
        backends: Object.freeze(backends),
        hookRegistrations: Object.freeze(hookRegistrations),
        pluginDiagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    };
}
