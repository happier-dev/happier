import type {
    ActionDefinitionV1,
    BackendDefinitionV1,
    BackendRuntimeAdapterV1,
    ProviderDefinitionV1,
} from '@happier-dev/protocol';
import { BackendRuntimeAdapterOperationCatalogV1 } from '@happier-dev/protocol';
import type {
    BackendDefinitionContractV1,
    ProviderDefinitionContractV1,
} from '@happier-dev/agents';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';

import { loadInstalledPlugins } from '../load/installed';
import type { PluginCompatibilityDiagnostic } from '../diagnostics/types';
import { buildPluginContributionRegistry } from './normalize/package';
import { createPluginBindings } from '../runtime/bindings/plugin';
import {
    normalizeBuiltInAgentId,
    resolveContributionProviderAgentId,
} from './resolveContributionProviderAgentId';

import type {
    ResolvedActionContribution,
    ResolvedBackendContribution,
    ResolvedCatalogEntry,
    ResolvedCommandContribution,
    ResolvedContributionInputs,
    ResolvedHookRegistration,
    ResolvedLifecycleHandlerContribution,
    ResolvedProviderContribution,
    ResolvedResourceContribution,
    ResolvedToolContribution,
    ResolvedUiDescriptorContribution,
    ResolvedActivationTarget,
} from './types';

type ResolvePluginContributionsParams = Readonly<{
    happyHomeDir?: string;
    existingProviderIds?: ReadonlySet<string>;
    existingBackendIds?: ReadonlySet<string>;
}>;

type PluginResolvedProviderContribution = ResolvedProviderContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedBackendContribution = ResolvedBackendContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    runtimeAdapters: readonly BackendRuntimeAdapterV1[];
}>;

type PluginResolvedActionContribution = ResolvedActionContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedToolContribution = ResolvedToolContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedCommandContribution = ResolvedCommandContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedResourceContribution = ResolvedResourceContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedUiDescriptorContribution = ResolvedUiDescriptorContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedLifecycleHandlerContribution = ResolvedLifecycleHandlerContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
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
    // `catalogEntry` passthrough remains an internal host projection seam in this
    // wave. Keep it strictly validated and provider-id aligned, but do not treat
    // it as a public plugin ABI contract.
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

function clonePluginProviderDefinition(definition: ProviderDefinitionV1): ProviderDefinitionV1 {
    return {
        ...definition,
        ownedBackendIds: [...(definition.ownedBackendIds ?? [])],
    };
}

function clonePluginBackendDefinition(definition: BackendDefinitionV1): BackendDefinitionV1 {
    return {
        ...definition,
        capabilities: { ...(definition.capabilities ?? {}) },
        runtimeAdapters: [...(definition.runtimeAdapters ?? [])],
    };
}

function sanitizeBuiltInCompatibilityAgentIds<TDefinition extends Readonly<Record<string, unknown>> & {
    providerAgentId?: string;
    iconAgentId?: string;
}>(params: Readonly<{
    pluginId: string;
    subjectLabel: string;
    definition: TDefinition;
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
}>): TDefinition {
    const sanitized = { ...params.definition } as TDefinition;
    if (!isValidBuiltInCompatibilityAgentId(sanitized.providerAgentId)) {
        if (typeof sanitized.providerAgentId === 'string' && sanitized.providerAgentId.trim().length > 0) {
            appendDiagnostic(params.diagnosticsByPluginId, params.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `${params.subjectLabel} providerAgentId must be an exact built-in agent id`,
            });
        }
        delete sanitized.providerAgentId;
    }
    if (!isValidBuiltInCompatibilityAgentId(sanitized.iconAgentId)) {
        if (typeof sanitized.iconAgentId === 'string' && sanitized.iconAgentId.trim().length > 0) {
            appendDiagnostic(params.diagnosticsByPluginId, params.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `${params.subjectLabel} iconAgentId must be an exact built-in agent id`,
            });
        }
        delete sanitized.iconAgentId;
    }
    return sanitized;
}

function isValidBuiltInCompatibilityAgentId(value: unknown): boolean {
    return normalizeBuiltInAgentId(value) !== null;
}

function readOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function buildSyntheticActionDefinitionFromTool(definition: PluginResolvedToolContribution['definition']): ActionDefinitionV1 {
    return {
        kindVersion: 1,
        id: definition.actionId,
        title: definition.title,
        description: definition.description ?? null,
        safety: definition.safety,
        placements: [],
        slash: null,
        bindings: {
            mcpToolName: definition.name,
        },
        examples: definition.examples ?? null,
        surfaces: {
            ui_button: false,
            ui_slash_command: false,
            voice_tool: false,
            voice_action_block: false,
            session_agent: definition.surfaces.session_agent,
            mcp: definition.surfaces.mcp,
            cli: definition.surfaces.cli,
        },
        inputHints: definition.inputHints ?? null,
        inputSchema: definition.inputSchema ?? {},
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
    };
}

function buildSyntheticActionDefinitionFromCommand(definition: PluginResolvedCommandContribution['definition']): ActionDefinitionV1 {
    return {
        kindVersion: 1,
        id: definition.actionId,
        title: definition.rootHelpLabel ?? definition.command,
        description: definition.rootHelpDescription ?? null,
        safety: 'safe',
        placements: [],
        slash: null,
        bindings: null,
        examples: null,
        surfaces: {
            ui_button: false,
            ui_slash_command: false,
            voice_tool: false,
            voice_action_block: false,
            session_agent: false,
            mcp: false,
            cli: true,
        },
        inputHints: null,
        inputSchema: {
            type: 'object',
            properties: {
                argv: {
                    type: 'array',
                },
                rawArgv: {
                    type: 'array',
                },
            },
            additionalProperties: true,
        },
    };
}

function readProviderSettingsBackendId(definition: ProviderDefinitionV1): string | null {
    return readOptionalString(definition.settingsBackendId);
}

function withProviderSettingsBackendId(
    provider: PluginResolvedProviderContribution,
    settingsBackendId: string | null,
): PluginResolvedProviderContribution {
    if (provider.richDefinition?.provenance !== 'external') {
        return provider;
    }

    const definition = { ...provider.richDefinition.definition };
    if (settingsBackendId) {
        definition.settingsBackendId = settingsBackendId;
    } else {
        delete definition.settingsBackendId;
    }

    return {
        ...provider,
        richDefinition: {
            provenance: 'external',
            definition,
        },
    };
}

function hasTerminalRuntimeLaunchAdapter(runtimeAdapters: readonly BackendRuntimeAdapterV1[]): boolean {
    return runtimeAdapters.some((runtimeAdapter) => (
        runtimeAdapter.kind === 'terminalRuntime'
        && runtimeAdapter.operation === BackendRuntimeAdapterOperationCatalogV1.terminalRuntime.launch
    ));
}

export async function resolvePluginContributions(
    params: ResolvePluginContributionsParams = {},
): Promise<ResolvedContributionInputs> {
    const loadResult = await loadInstalledPlugins({ happyHomeDir: params.happyHomeDir });
    const pluginRegistry = buildPluginContributionRegistry({ loadedPlugins: loadResult.loadedPlugins });
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const knownProviderIds = new Set(params.existingProviderIds ?? []);
    const knownBackendIds = new Set(params.existingBackendIds ?? []);
    const pluginProviderOwnerById = new Map<string, string>();
    const providerCandidates: PluginResolvedProviderContribution[] = [];
    const backendCandidates: PluginResolvedBackendContribution[] = [];
    const actionCandidates: PluginResolvedActionContribution[] = [];
    const toolCandidates: PluginResolvedToolContribution[] = [];
    const commandCandidates: PluginResolvedCommandContribution[] = [];
    const resourceCandidates: PluginResolvedResourceContribution[] = [];
    const uiDescriptorCandidates: PluginResolvedUiDescriptorContribution[] = [];
    const lifecycleHandlerCandidates: PluginResolvedLifecycleHandlerContribution[] = [];
    const activationTargets: ResolvedActivationTarget[] = [];
    const hookRegistrations: ResolvedHookRegistration[] = [];

    for (const [pluginId, diagnostics] of Object.entries(loadResult.diagnosticsByPluginId)) {
        diagnosticsByPluginId[pluginId] = [...diagnostics];
    }

    for (const plugin of loadResult.loadedPlugins) {
        if (!plugin.daemonEntryPath) {
            continue;
        }
        activationTargets.push({
            provenance: 'external',
            source: { kind: plugin.sourceSpec.kind },
            pluginId: plugin.pluginId,
            manifestPath: plugin.manifestPath,
            manifestDigest: plugin.manifestDigest,
            daemonEntryPath: plugin.daemonEntryPath,
            sourceSpec: plugin.sourceSpec,
        });
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
        pluginProviderOwnerById.set(contribution.definition.id, contribution.pluginId);
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
        const richDefinition = sanitizeBuiltInCompatibilityAgentIds({
            pluginId: contribution.pluginId,
            subjectLabel: `Plugin provider '${contribution.definition.id}'`,
            definition: clonePluginProviderDefinition(contribution.definition),
            diagnosticsByPluginId,
        });
        providerCandidates.push({
            id: contribution.definition.id,
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            definition: Object.freeze({
                kindVersion: 1,
                id: contribution.definition.id,
                ownedBackendIds: Object.freeze([...contribution.definition.ownedBackendIds]),
            }) satisfies ProviderDefinitionContractV1,
            richDefinition: {
                provenance: 'external',
                definition: richDefinition,
            },
            runtimeSpec,
            catalogEntry,
            sourceSpec: contribution.sourceSpec,
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

        const providerOwnerPluginId = pluginProviderOwnerById.get(contribution.definition.providerId);
        if (providerOwnerPluginId !== contribution.pluginId) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin backend '${contribution.definition.id}' references provider '${contribution.definition.providerId}' not owned by the same plugin`,
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
        const richDefinition = sanitizeBuiltInCompatibilityAgentIds({
            pluginId: contribution.pluginId,
            subjectLabel: `Plugin backend '${contribution.definition.id}'`,
            definition: clonePluginBackendDefinition(contribution.definition),
            diagnosticsByPluginId,
        });
        backendCandidates.push({
            id: contribution.definition.id,
            providerId: contribution.definition.providerId,
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            definition: Object.freeze({
                kindVersion: 1,
                id: contribution.definition.id,
                providerId: contribution.definition.providerId,
            }) satisfies BackendDefinitionContractV1,
            richDefinition: {
                provenance: 'external',
                definition: richDefinition,
            },
            runtimeKind: contribution.definition.runtimeKind,
            capabilities: Object.freeze({ ...(contribution.definition.capabilities ?? {}) }),
            runtimeAdapters: Object.freeze([...contribution.definition.runtimeAdapters]),
            sourceSpec: contribution.sourceSpec,
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
        });
    }

    for (const contribution of pluginRegistry.actions) {
        actionCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.tools) {
        toolCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
        actionCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: buildSyntheticActionDefinitionFromTool(contribution.definition),
        });
    }

    for (const contribution of pluginRegistry.commands) {
        commandCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
        actionCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: buildSyntheticActionDefinitionFromCommand(contribution.definition),
        });
    }

    for (const contribution of pluginRegistry.resources) {
        resourceCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.uiDescriptors) {
        uiDescriptorCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.lifecycleHandlers) {
        lifecycleHandlerCandidates.push({
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    const availableBackendProviderIds = new Map<string, string>();
    for (const backend of backendCandidates) {
        availableBackendProviderIds.set(backend.id, backend.providerId);
    }

    const normalizedProviderCandidates = providerCandidates.map((provider) => {
        const resolvedOwnedBackendIds = provider.definition.ownedBackendIds.filter((backendId) => (
            availableBackendProviderIds.get(backendId) === provider.id
        ));
        const declaredSettingsBackendId = provider.richDefinition?.provenance === 'external'
            ? readProviderSettingsBackendId(provider.richDefinition.definition)
            : null;

        if (declaredSettingsBackendId) {
            if (resolvedOwnedBackendIds.includes(declaredSettingsBackendId)) {
                return withProviderSettingsBackendId(provider, declaredSettingsBackendId);
            }

            appendDiagnostic(diagnosticsByPluginId, provider.pluginId ?? provider.id, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin provider '${provider.id}' settingsBackendId must resolve to one of its owned backends`,
            });
            return withProviderSettingsBackendId(provider, null);
        }

        if (resolvedOwnedBackendIds.length === 1) {
            return withProviderSettingsBackendId(provider, resolvedOwnedBackendIds[0] ?? null);
        }

        if (resolvedOwnedBackendIds.length > 1) {
            appendDiagnostic(diagnosticsByPluginId, provider.pluginId ?? provider.id, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin provider '${provider.id}' owns multiple backends and must declare settingsBackendId for provider settings binding`,
            });
        }

        return withProviderSettingsBackendId(provider, null);
    });

    const invalidProviderIds = new Set<string>();
    for (const provider of normalizedProviderCandidates) {
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

    const providers = normalizedProviderCandidates.filter((provider) => !invalidProviderIds.has(provider.id));
    const providerById = new Map(providers.map((provider) => [provider.id, provider] as const));
    const backends = backendCandidates.flatMap((backend) => {
        if (!invalidProviderIds.has(backend.providerId)) {
            const provider = providerById.get(backend.providerId);
            if (!provider) {
                appendDiagnostic(diagnosticsByPluginId, backend.pluginId ?? backend.id, {
                    code: 'plugin_manifest_semantic_invalid',
                    message: `Plugin backend '${backend.id}' is excluded because provider '${backend.providerId}' is missing after validation`,
                });
                return [];
            }

            const runtimeBindingRequiresCompatibilityCarrier = hasTerminalRuntimeLaunchAdapter(backend.runtimeAdapters);
            const compatibilityCarrier = resolveContributionProviderAgentId({
                backend,
                provider,
            });
            if (runtimeBindingRequiresCompatibilityCarrier && compatibilityCarrier === null) {
                appendDiagnostic(diagnosticsByPluginId, backend.pluginId ?? backend.id, {
                    code: 'plugin_manifest_semantic_invalid',
                    message: `Plugin backend '${backend.id}' cannot become a live session runtime because no exact built-in providerAgentId compatibility carrier resolves`,
                });
                return [backend];
            }

            return [{
                ...backend,
                getBindings: async () => createPluginBindings({
                    backend,
                    provider,
                }),
            }];
        }

        appendDiagnostic(diagnosticsByPluginId, backend.pluginId ?? backend.id, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin backend '${backend.id}' is excluded because provider '${backend.providerId}' is invalid`,
        });
        return [];
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
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    return {
        providers: Object.freeze(providers),
        backends: Object.freeze(backends),
        actions: Object.freeze(actionCandidates),
        tools: Object.freeze(toolCandidates),
        commands: Object.freeze(commandCandidates),
        resources: Object.freeze(resourceCandidates),
        uiDescriptors: Object.freeze(uiDescriptorCandidates),
        activationTargets: Object.freeze(activationTargets),
        hookRegistrations: Object.freeze(hookRegistrations),
        lifecycleHandlers: Object.freeze(lifecycleHandlerCandidates),
        pluginDiagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    };
}
