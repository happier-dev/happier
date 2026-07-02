import type {
    ActionDefinitionV1,
    BackendDefinitionV1,
    PluginBackendCapabilitiesV1,
    BackendSurfaceDeclarationV1,
    ProviderDefinitionV1,
} from '@happier-dev/protocol';
import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/protocol';
import type {
    BackendDefinitionContractV1,
    ProviderDefinitionContractV1,
} from '@happier-dev/agents';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';

import { loadInstalledPlugins } from '../../discovery/load/installed';
import type { CanonicalPluginBackendDefinition } from '../../manifest/types';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import { buildPluginContributionRegistry } from './normalize/package';
import { createPluginRuntimeCoreFactory } from '../../runtime/runtimeCore/plugin';
import {
    normalizeBuiltInAgentId,
    resolveContributionProviderAgentId,
} from './resolveContributionProviderAgentId';

import type {
    ResolvedActionContribution,
    ResolvedBackendContribution,
    ResolvedCatalogEntry,
    ResolvedCommandContribution,
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedContributionInputs,
    ResolvedExecutionRunProfileContribution,
    ResolvedEventContribution,
    ResolvedHostedWebContribution,
    ResolvedHookRegistration,
    ResolvedInstallableContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedMcpDiscoveryProviderContribution,
    ResolvedMcpServerContribution,
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
    ResolvedReactNativeBundleContribution,
    ResolvedRequestInterceptorContribution,
    ResolvedScmBackendContribution,
    ResolvedSettingsContribution,
    ResolvedScmHostingProviderContribution,
    ResolvedProviderContribution,
    ResolvedResourceContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedSessionSurfaceContribution,
    ResolvedStructuredMessageContribution,
    ResolvedToolContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiDescriptorContribution,
    ResolvedUiTranslationsContribution,
    ResolvedActivationTarget,
} from './types';

type ResolvePluginContributesParams = Readonly<{
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
    surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
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

type PluginResolvedUiTranslationsContribution = ResolvedUiTranslationsContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedStructuredMessageContribution = ResolvedStructuredMessageContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSessionSurfaceContribution = ResolvedSessionSurfaceContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSessionHeaderActionContribution = ResolvedSessionHeaderActionContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedHostedWebContribution = ResolvedHostedWebContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedReactNativeBundleContribution = ResolvedReactNativeBundleContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedUiArtifactContribution = ResolvedUiArtifactContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedNotificationCategoryContribution = ResolvedNotificationCategoryContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedNotificationChannelContribution = ResolvedNotificationChannelContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedEventContribution = ResolvedEventContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSettingsContribution = ResolvedSettingsContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedExecutionRunProfileContribution = ResolvedExecutionRunProfileContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedMcpServerContribution = ResolvedMcpServerContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedMcpDiscoveryProviderContribution = ResolvedMcpDiscoveryProviderContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedInstallableContribution = ResolvedInstallableContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedRequestInterceptorContribution = ResolvedRequestInterceptorContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedConnectedAccountDescriptorContribution =
    ResolvedConnectedAccountDescriptorContribution & Readonly<{
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

type PluginResolvedScmHostingProviderContribution = ResolvedScmHostingProviderContribution & Readonly<{
    provenance: 'external';
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedScmBackendContribution = ResolvedScmBackendContribution & Readonly<{
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

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isProviderCliInstallCommand(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.cmd === 'string'
        && isStringArray(value.args)
        && (value.requiresAdmin === undefined || typeof value.requiresAdmin === 'boolean')
        && (value.note === undefined || value.note === null || typeof value.note === 'string');
}

function isProviderCliManagedInstallSpec(
    value: unknown,
): value is NonNullable<ProviderCliRuntimeDescriptor['managedInstall']> {
    if (!isRecord(value)) {
        return false;
    }
    if (value.kind === 'github_release_binary') {
        return typeof value.githubRepo === 'string'
            && typeof value.binaryName === 'string';
    }
    if (value.kind === 'managed_package') {
        return typeof value.packageName === 'string'
            && typeof value.binaryName === 'string';
    }
    return false;
}

function isProviderCliManualInstallRecipes(
    value: unknown,
): value is ProviderCliRuntimeDescriptor['manualInstallRecipes'] {
    if (value === null) {
        return true;
    }
    if (!isRecord(value)) {
        return false;
    }
    return ['darwin', 'linux', 'win32'].every((platform) => {
        const commands = value[platform];
        return commands === undefined
            || (Array.isArray(commands) && commands.every(isProviderCliInstallCommand));
    });
}

function isProviderCliRuntimeDescriptor(value: unknown): value is ProviderCliRuntimeDescriptor {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.id === 'string'
        && typeof value.title === 'string'
        && typeof value.binaryName === 'string'
        && (value.alternativeBinaryNames === undefined || isStringArray(value.alternativeBinaryNames))
        && (
            value.alternativeBinaryFallbackEnabledEnvVar === undefined
            || value.alternativeBinaryFallbackEnabledEnvVar === null
            || typeof value.alternativeBinaryFallbackEnabledEnvVar === 'string'
        )
        && (
            value.knownUserBinDirSuffixes === undefined
            || value.knownUserBinDirSuffixes === null
            || isStringArray(value.knownUserBinDirSuffixes)
        )
        && (value.sourcePreferenceDefault === 'system-first' || value.sourcePreferenceDefault === 'managed-first')
        && (value.managedInstall === null || isProviderCliManagedInstallSpec(value.managedInstall))
        && (
            value.manualInstallKind === 'command'
            || value.manualInstallKind === 'vendor_recipe'
            || value.manualInstallKind === 'none'
        )
        && isProviderCliManualInstallRecipes(value.manualInstallRecipes)
        && typeof value.acceptsJavaScriptFileOverride === 'boolean'
        && (value.installGuideUrl === undefined || value.installGuideUrl === null || typeof value.installGuideUrl === 'string')
        && (value.docsUrl === undefined || value.docsUrl === null || typeof value.docsUrl === 'string');
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
    const runtime = readExternalPluginAgentCliRuntimeWithLegacyProviderFallback(definition);
    if (!runtime) {
        return null;
    }
    if (!isProviderCliRuntimeDescriptor(runtime)) {
        appendDiagnostic(diagnosticsByPluginId, pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${providerId}' runtime descriptor must match the provider CLI runtime contract`,
        });
        return null;
    }
    if (runtime.id !== providerId) {
        appendDiagnostic(diagnosticsByPluginId, pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Plugin provider '${providerId}' runtime descriptor id must match the provider id`,
        });
        return null;
    }
    return {
        ...runtime,
        id: runtime.id,
    };
}

function readExternalPluginAgentCliRuntimeWithLegacyProviderFallback(
    definition: ProviderDefinitionV1,
): unknown {
    if (definition.agentCliRuntime !== undefined) {
        return definition.agentCliRuntime;
    }

    // External plugin manifests may still arrive with the legacy provider-era key.
    // First-party bundled definitions are generated from plugin-owned source and must use agentCliRuntime.
    return definition.providerCliRuntime;
}

function clonePluginProviderDefinition(definition: ProviderDefinitionV1): ProviderDefinitionV1 {
    return {
        ...definition,
        ownedBackendIds: [...(definition.ownedBackendIds ?? [])],
    };
}

function clonePluginBackendDefinition(
    definition: CanonicalPluginBackendDefinition,
): Omit<BackendDefinitionV1, 'capabilities' | 'surfaceHandlers'> & Readonly<{
    capabilities: PluginBackendCapabilitiesV1;
    surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
}> {
    return {
        ...definition,
        capabilities: clonePluginBackendCapabilities(definition.capabilities),
        surfaceHandlers: [...readSurfaceHandlers(definition)],
    };
}

function clonePluginBackendCapabilities(capabilities: PluginBackendCapabilitiesV1): PluginBackendCapabilitiesV1 {
    return Object.freeze({
        ...capabilities,
        executionRun: Object.freeze({
            ...capabilities.executionRun,
        }),
    });
}

function readSurfaceHandlers(definition: Readonly<Record<string, unknown>>): readonly BackendSurfaceDeclarationV1[] {
    return Array.isArray(definition.surfaceHandlers)
        ? definition.surfaceHandlers as readonly BackendSurfaceDeclarationV1[]
        : [];
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

function readRequiredString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
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
            ui: false,
            voice: false,
            session_agent: definition.surfaces.session_agent,
            mcp: definition.surfaces.mcp,
            cli: definition.surfaces.cli,
            rpc: false,
            sdk: false,
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
            ui: false,
            voice: false,
            session_agent: false,
            mcp: false,
            cli: true,
            rpc: false,
            sdk: false,
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

function hasTerminalRuntimeLaunchSurface(surfaceHandlers: readonly BackendSurfaceDeclarationV1[]): boolean {
    return surfaceHandlers.some((surfaceHandler) => (
        surfaceHandler.kind === 'terminalRuntime'
        && surfaceHandler.operation === BackendSurfaceOperationCatalogV1.terminalRuntime.launch
    ));
}

function isProviderlessReviewExecutionRunBackend(definition: Readonly<{
    capabilities?: PluginBackendCapabilitiesV1;
    surfaceHandlers?: readonly BackendSurfaceDeclarationV1[];
}>): boolean {
    if (!definition.capabilities) {
        return false;
    }
    const session = definition.capabilities.session;
    const executionRun = definition.capabilities.executionRun;
    return isRecord(session)
        && session.supported === false
        && isRecord(executionRun)
        && executionRun.supported !== false
        && isRecord(executionRun.review)
        && !hasTerminalRuntimeLaunchSurface(definition.surfaceHandlers ?? []);
}

export async function resolvePluginContributes(
    params: ResolvePluginContributesParams = {},
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
    const uiTranslationCandidates: PluginResolvedUiTranslationsContribution[] = [];
    const structuredMessageCandidates: PluginResolvedStructuredMessageContribution[] = [];
    const sessionSurfaceCandidates: PluginResolvedSessionSurfaceContribution[] = [];
    const sessionHeaderActionCandidates: PluginResolvedSessionHeaderActionContribution[] = [];
    const hostedWebCandidates: PluginResolvedHostedWebContribution[] = [];
    const reactNativeBundleCandidates: PluginResolvedReactNativeBundleContribution[] = [];
    const uiArtifactCandidates: PluginResolvedUiArtifactContribution[] = [];
    const settingsCandidates: PluginResolvedSettingsContribution[] = [];
    const notificationCandidates: PluginResolvedNotificationCategoryContribution[] = [];
    const notificationChannelCandidates: PluginResolvedNotificationChannelContribution[] = [];
    const eventCandidates: PluginResolvedEventContribution[] = [];
    const executionRunProfileCandidates: PluginResolvedExecutionRunProfileContribution[] = [];
    const mcpServerCandidates: PluginResolvedMcpServerContribution[] = [];
    const mcpDiscoveryProviderCandidates: PluginResolvedMcpDiscoveryProviderContribution[] = [];
    const scmHostingProviderCandidates: PluginResolvedScmHostingProviderContribution[] = [];
    const scmBackendCandidates: PluginResolvedScmBackendContribution[] = [];
    const connectedAccountDescriptorCandidates: PluginResolvedConnectedAccountDescriptorContribution[] = [];
    const installableCandidates: PluginResolvedInstallableContribution[] = [];
    const requestInterceptorCandidates: PluginResolvedRequestInterceptorContribution[] = [];
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
        const providerId = readRequiredString(contribution.definition.id);
        if (knownProviderIds.has(providerId)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin provider '${providerId}' collides with an existing provider id`,
            });
            continue;
        }

        knownProviderIds.add(providerId);
        pluginProviderOwnerById.set(providerId, contribution.pluginId);
        const catalogEntry = readPluginCatalogEntry({
            pluginId: contribution.pluginId,
            providerId,
            definition: contribution.definition,
            diagnosticsByPluginId,
        });
        const runtimeSpec = readPluginProviderCliRuntime(
            contribution.pluginId,
            providerId,
            contribution.definition,
            diagnosticsByPluginId,
        );
        const richDefinition = sanitizeBuiltInCompatibilityAgentIds({
            pluginId: contribution.pluginId,
            subjectLabel: `Plugin provider '${providerId}'`,
            definition: clonePluginProviderDefinition(contribution.definition),
            diagnosticsByPluginId,
        });
        providerCandidates.push({
            id: providerId,
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            definition: Object.freeze({
                kindVersion: 1,
                id: providerId,
                ownedBackendIds: Object.freeze(readStringArray(contribution.definition.ownedBackendIds)),
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
        const backendId = readRequiredString(contribution.definition.id);
        const providerId = readRequiredString(contribution.definition.providerId);
        if (knownBackendIds.has(backendId)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin backend '${backendId}' collides with an existing backend id`,
            });
            continue;
        }

        const providerOwnerPluginId = pluginProviderOwnerById.get(providerId);
        const surfaceHandlers = readSurfaceHandlers(contribution.definition);
        const providerlessReviewBackend = isProviderlessReviewExecutionRunBackend({
            capabilities: contribution.definition.capabilities,
            surfaceHandlers,
        });
        if (!providerlessReviewBackend && providerOwnerPluginId !== contribution.pluginId) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin backend '${backendId}' references provider '${providerId}' not owned by the same plugin`,
            });
            continue;
        }

        if (!providerlessReviewBackend && !knownProviderIds.has(providerId)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin backend '${backendId}' references missing provider '${providerId}'`,
            });
            continue;
        }

        knownBackendIds.add(backendId);
        const richDefinition = sanitizeBuiltInCompatibilityAgentIds({
            pluginId: contribution.pluginId,
            subjectLabel: `Plugin backend '${backendId}'`,
            definition: clonePluginBackendDefinition(contribution.definition),
            diagnosticsByPluginId,
        });
        backendCandidates.push({
            id: backendId,
            providerId,
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            definition: Object.freeze({
                kindVersion: 1,
                id: backendId,
                providerId,
            }) satisfies BackendDefinitionContractV1,
            richDefinition: {
                provenance: 'external',
                definition: richDefinition,
            },
            runtimeKind: readOptionalString(contribution.definition.runtimeKind),
            capabilities: clonePluginBackendCapabilities(contribution.definition.capabilities),
            surfaceHandlers: Object.freeze([...surfaceHandlers]),
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

    for (const contribution of pluginRegistry.uiTranslations) {
        uiTranslationCandidates.push({
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

    for (const contribution of pluginRegistry.structuredMessages) {
        structuredMessageCandidates.push({
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

    for (const contribution of pluginRegistry.sessionSurfaces) {
        sessionSurfaceCandidates.push({
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

    for (const contribution of pluginRegistry.sessionHeaderActions) {
        sessionHeaderActionCandidates.push({
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

    for (const contribution of pluginRegistry.hostedWeb) {
        hostedWebCandidates.push({
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

    for (const contribution of pluginRegistry.reactNativeBundles) {
        reactNativeBundleCandidates.push({
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

    for (const contribution of pluginRegistry.uiArtifacts) {
        uiArtifactCandidates.push({
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

    for (const contribution of pluginRegistry.settings) {
        settingsCandidates.push({
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

    for (const contribution of pluginRegistry.notifications) {
        notificationCandidates.push({
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

    for (const contribution of pluginRegistry.notificationChannels) {
        notificationChannelCandidates.push({
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

    for (const contribution of pluginRegistry.events) {
        eventCandidates.push({
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

    for (const contribution of pluginRegistry.executionRunProfiles) {
        executionRunProfileCandidates.push({
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

    for (const contribution of pluginRegistry.mcpServers) {
        mcpServerCandidates.push({
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

    for (const contribution of pluginRegistry.mcpDiscoveryProviders) {
        mcpDiscoveryProviderCandidates.push({
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

    for (const contribution of pluginRegistry.scmHostingProviders) {
        scmHostingProviderCandidates.push({
            id: contribution.definition.id,
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

    for (const contribution of pluginRegistry.scmBackends) {
        scmBackendCandidates.push({
            id: contribution.definition.id,
            provenance: 'external',
            source: { kind: contribution.sourceSpec.kind },
            identity: contribution.identity,
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.connectedAccountDescriptors) {
        connectedAccountDescriptorCandidates.push({
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

    for (const contribution of pluginRegistry.installables) {
        installableCandidates.push({
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

    for (const contribution of pluginRegistry.requestInterceptors) {
        requestInterceptorCandidates.push({
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
        if (isProviderlessReviewExecutionRunBackend(backend)) {
            return [backend];
        }

        if (!invalidProviderIds.has(backend.providerId)) {
            const provider = providerById.get(backend.providerId);
            if (!provider) {
                appendDiagnostic(diagnosticsByPluginId, backend.pluginId ?? backend.id, {
                    code: 'plugin_manifest_semantic_invalid',
                    message: `Plugin backend '${backend.id}' is excluded because provider '${backend.providerId}' is missing after validation`,
                });
                return [];
            }

            const runtimeBindingRequiresCompatibilityCarrier = hasTerminalRuntimeLaunchSurface(backend.surfaceHandlers);
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
                getRuntimeCore: async () => createPluginRuntimeCoreFactory({
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
        uiTranslations: Object.freeze(uiTranslationCandidates),
        structuredMessages: Object.freeze(structuredMessageCandidates),
        sessionSurfaces: Object.freeze(sessionSurfaceCandidates),
        sessionHeaderActions: Object.freeze(sessionHeaderActionCandidates),
        hostedWeb: Object.freeze(hostedWebCandidates),
        reactNativeBundles: Object.freeze(reactNativeBundleCandidates),
        uiArtifacts: Object.freeze(uiArtifactCandidates),
        settings: Object.freeze(settingsCandidates),
        notifications: Object.freeze(notificationCandidates),
        notificationChannels: Object.freeze(notificationChannelCandidates),
        events: Object.freeze(eventCandidates),
        executionRunProfiles: Object.freeze(executionRunProfileCandidates),
        mcpServers: Object.freeze(mcpServerCandidates),
        mcpDiscoveryProviders: Object.freeze(mcpDiscoveryProviderCandidates),
        scmHostingProviders: Object.freeze(scmHostingProviderCandidates),
        scmBackends: Object.freeze(scmBackendCandidates),
        connectedAccountDescriptors: Object.freeze(connectedAccountDescriptorCandidates),
        installables: Object.freeze(installableCandidates),
        requestInterceptors: Object.freeze(requestInterceptorCandidates),
        activationTargets: Object.freeze(activationTargets),
        hookRegistrations: Object.freeze(hookRegistrations),
        lifecycleHandlers: Object.freeze(lifecycleHandlerCandidates),
        pluginDiagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    };
}
