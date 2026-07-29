import { loadInstalledPlugins } from '../../discovery/load/installed';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import { buildPluginContributionRegistry } from './normalize/package';
import { loadBundledPluginLocators } from './builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPlugins';
import { collectNormalizedRegistryIntrospectionCandidates } from '@/plugins/projection/introspection/normalizedRegistry';
import {
    createNativeAgentCliCatalogEntry,
    projectNativeAgentCliRuntimeDescriptor,
} from './agentCliMetadata';

import type {
    ResolvedActionContribution,
    ResolvedBrowserActionContribution,
    ResolvedBrowserTargetContribution,
    ResolvedCommandContribution,
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedContributionInputs,
    ResolvedContributionProvenance,
    ResolvedExecutionRunProfileContribution,
    ResolvedEventContribution,
    ResolvedHostedWebContribution,
    ResolvedInstallableContribution,
    ResolvedMcpDiscoveryProviderContribution,
    ResolvedMcpServerContribution,
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
    ResolvedProviderContribution,
    ResolvedPromptAssetContribution,
    ResolvedReactNativeBundleContribution,
    ResolvedRequestInterceptorContribution,
    ResolvedScmBackendContribution,
    ResolvedSettingsContribution,
    ResolvedScmHostingProviderContribution,
    ResolvedAgentContribution,
    ResolvedResourceContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedSurfacePlacementContribution,
    ResolvedStructuredMessageContribution,
    ResolvedSystemToolContribution,
    ResolvedToolContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiTranslationsContribution,
    ResolvedUiRendererV2Contribution,
    ResolvedUiTranslationBundleV2Contribution,
    ResolvedUiViewV2Contribution,
    ResolvedActivationTarget,
    ResolvedVoiceModelPackContribution,
    ResolvedVoiceProviderContribution,
} from './types';

type ResolvePluginContributesParams = Readonly<{
    happyHomeDir?: string;
    existingAgentIds?: ReadonlySet<string>;
}>;

type PluginResolvedAgentContribution = ResolvedAgentContribution & Readonly<{
    identity: NonNullable<ResolvedAgentContribution['identity']>;
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedProviderContribution = ResolvedProviderContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
}>;

type PluginResolvedActionContribution = ResolvedActionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedToolContribution = ResolvedToolContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedCommandContribution = ResolvedCommandContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedResourceContribution = ResolvedResourceContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    pluginRootPath: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedPromptAssetContribution = ResolvedPromptAssetContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
}>;

type PluginResolvedUiTranslationsContribution = ResolvedUiTranslationsContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedStructuredMessageContribution = ResolvedStructuredMessageContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSessionHeaderActionContribution = ResolvedSessionHeaderActionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSurfacePlacementContribution = ResolvedSurfacePlacementContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedHostedWebContribution = ResolvedHostedWebContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedReactNativeBundleContribution = ResolvedReactNativeBundleContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedUiArtifactContribution = ResolvedUiArtifactContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedBrowserTargetContribution = ResolvedBrowserTargetContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedBrowserActionContribution = ResolvedBrowserActionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedNotificationCategoryContribution = ResolvedNotificationCategoryContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedNotificationChannelContribution = ResolvedNotificationChannelContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedEventContribution = ResolvedEventContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSettingsContribution = ResolvedSettingsContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedExecutionRunProfileContribution = ResolvedExecutionRunProfileContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedMcpServerContribution = ResolvedMcpServerContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedMcpDiscoveryProviderContribution = ResolvedMcpDiscoveryProviderContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedInstallableContribution = ResolvedInstallableContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSystemToolContribution = ResolvedSystemToolContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedRequestInterceptorContribution = ResolvedRequestInterceptorContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedConnectedAccountDescriptorContribution =
    ResolvedConnectedAccountDescriptorContribution & Readonly<{
        provenance: ResolvedContributionProvenance;
        pluginId: string;
        manifestPath: string;
        manifestDigest: string;
        daemonEntryPath: string | null;
    }>;

type PluginResolvedScmHostingProviderContribution = ResolvedScmHostingProviderContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedScmBackendContribution = ResolvedScmBackendContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
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

export async function resolvePluginContributes(
    params: ResolvePluginContributesParams = {},
): Promise<ResolvedContributionInputs> {
    const loadResult = await loadInstalledPlugins({ happyHomeDir: params.happyHomeDir });
    return projectLoadedPluginContributes({
        loadResult,
        provenance: 'external',
        existingAgentIds: params.existingAgentIds,
    });
}

export function projectLoadedPluginContributes(
    params: Omit<ResolvePluginContributesParams, 'happyHomeDir'> & Readonly<{
        loadResult: Awaited<ReturnType<typeof loadInstalledPlugins>>;
        provenance: ResolvedContributionProvenance;
    }>,
): ResolvedContributionInputs {
    const { loadResult } = params;
    const pluginRegistry = buildPluginContributionRegistry({
        loadedPlugins: loadResult.loadedPlugins,
        ...(params.provenance === 'external'
            ? {
                referencePlugins: loadBundledPluginLocators(
                    BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
                ),
            }
            : {}),
    });
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const knownAgentIds = new Set(params.existingAgentIds ?? []);
    const uiViewV2Candidates: ResolvedUiViewV2Contribution[] = [];
    const uiRendererV2Candidates: ResolvedUiRendererV2Contribution[] = [];
    const uiTranslationV2Candidates: ResolvedUiTranslationBundleV2Contribution[] = [];
    const agentCandidates: PluginResolvedAgentContribution[] = [];
    const providerCandidates: PluginResolvedProviderContribution[] = [];
    const actionCandidates: PluginResolvedActionContribution[] = [];
    const toolCandidates: PluginResolvedToolContribution[] = [];
    const commandCandidates: PluginResolvedCommandContribution[] = [];
    const resourceCandidates: PluginResolvedResourceContribution[] = [];
    const promptAssetCandidates: PluginResolvedPromptAssetContribution[] = [];
    const uiTranslationCandidates: PluginResolvedUiTranslationsContribution[] = [];
    const structuredMessageCandidates: PluginResolvedStructuredMessageContribution[] = [];
    const sessionHeaderActionCandidates: PluginResolvedSessionHeaderActionContribution[] = [];
    const surfacePlacementCandidates: PluginResolvedSurfacePlacementContribution[] = [];
    const hostedWebCandidates: PluginResolvedHostedWebContribution[] = [];
    const reactNativeBundleCandidates: PluginResolvedReactNativeBundleContribution[] = [];
    const uiArtifactCandidates: PluginResolvedUiArtifactContribution[] = [];
    const browserTargetCandidates: PluginResolvedBrowserTargetContribution[] = [];
    const browserActionCandidates: PluginResolvedBrowserActionContribution[] = [];
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
    const managedDependencyCandidates: PluginResolvedInstallableContribution[] = [];
    const systemToolCandidates: PluginResolvedSystemToolContribution[] = [];
    const requestInterceptorCandidates: PluginResolvedRequestInterceptorContribution[] = [];
    const voiceModelPackCandidates: ResolvedVoiceModelPackContribution[] = [];
    const voiceProviderCandidates: ResolvedVoiceProviderContribution[] = [];

    for (const contribution of pluginRegistry.uiViewsV2) {
        uiViewV2Candidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.uiRenderersV2) {
        uiRendererV2Candidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            pluginRootPath: contribution.pluginRootPath,
            ...(contribution.generatedUiArtifactsManifest
                ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
                : {}),
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.uiTranslationsV2) {
        uiTranslationV2Candidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            localeIdentity: contribution.localeIdentity,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.providers) {
        providerCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }
    const activationTargets: ResolvedActivationTarget[] = [];

    for (const [pluginId, diagnostics] of Object.entries(loadResult.diagnosticsByPluginId)) {
        diagnosticsByPluginId[pluginId] = [...diagnostics];
    }

    for (const plugin of loadResult.loadedPlugins) {
        if (!plugin.daemonEntryPath && !plugin.devDaemonEntryPath) {
            continue;
        }
        activationTargets.push({
            provenance: params.provenance,
            source: { kind: plugin.sourceSpec.kind },
            pluginId: plugin.pluginId,
            manifestPath: plugin.manifestPath,
            manifestDigest: plugin.manifestDigest,
            daemonEntryPath: plugin.daemonEntryPath,
            devDaemonEntryPath: plugin.devDaemonEntryPath,
            sourceSpec: plugin.sourceSpec,
            activationEvents: plugin.manifest.activation?.events.map((event) => event.kind) ?? [],
            manifest: plugin.manifest,
        });
    }

    for (const contribution of pluginRegistry.agents) {
        const agentId = contribution.definition.id;
        if (knownAgentIds.has(agentId)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin agent '${agentId}' collides with an existing agent id`,
            });
            continue;
        }

        knownAgentIds.add(agentId);
        const pluginHostAccess = loadResult.loadedPlugins.find((plugin) => (
            plugin.pluginId === contribution.pluginId
        ))?.manifest.hostAccess;
        if (!pluginHostAccess) {
            throw new Error(`Missing cold-manifest host access for Agent '${contribution.pluginId}/${agentId}'`);
        }
        const cliMetadata = contribution.definition.cli ?? null;
        agentCandidates.push({
            id: agentId,
            identity: contribution.identity!,
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            definition: Object.freeze({
                kindVersion: 1,
                id: agentId,
                ownedBackendIds: Object.freeze([]),
                ...(contribution.definition.providerRequirements
                    ? { providerRequirements: contribution.definition.providerRequirements }
                    : {}),
            }),
            richDefinition: {
                provenance: params.provenance,
                definition: contribution.definition,
            },
            runtimeSpec: cliMetadata
                ? projectNativeAgentCliRuntimeDescriptor({
                    agentId,
                    title: contribution.definition.title,
                    cli: cliMetadata,
                })
                : null,
            cliMetadata,
            catalogEntry: cliMetadata
                ? createNativeAgentCliCatalogEntry({ agentId, cli: cliMetadata })
                : null,
            sourceSpec: contribution.sourceSpec,
            pluginId: contribution.pluginId,
            hostAccess: pluginHostAccess,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
        });
    }

    for (const contribution of pluginRegistry.actions) {
        actionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.tools) {
        toolCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.commands) {
        commandCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.resources) {
        resourceCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginRootPath: contribution.pluginRootPath,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.uiTranslations) {
        uiTranslationCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.structuredMessages) {
        structuredMessageCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.sessionHeaderActions) {
        sessionHeaderActionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.surfacePlacements) {
        surfacePlacementCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.hostedWeb) {
        hostedWebCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.reactNativeBundles) {
        reactNativeBundleCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.uiArtifacts) {
        uiArtifactCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.browserTargets) {
        browserTargetCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.browserActions) {
        browserActionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.settings) {
        settingsCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.promptAssets) {
        promptAssetCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.notifications) {
        notificationCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.notificationChannels) {
        notificationChannelCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.events) {
        eventCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.executionRunProfiles) {
        executionRunProfileCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.mcpServers) {
        mcpServerCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.mcpDiscoveryProviders) {
        mcpDiscoveryProviderCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.scmHostingProviders) {
        scmHostingProviderCandidates.push({
            id: contribution.definition.id,
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.scmBackends) {
        scmBackendCandidates.push({
            id: contribution.definition.id,
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            identity: contribution.identity,
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.connectedAccountDescriptors) {
        connectedAccountDescriptorCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.managedDependencies) {
        managedDependencyCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.systemTools) {
        systemToolCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.requestInterceptors) {
        requestInterceptorCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
      });
    }

    for (const contribution of pluginRegistry.voiceModelPacks) {
        voiceModelPackCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.voiceProviders) {
        voiceProviderCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            manifestDigest: contribution.manifestDigest,
            pluginRootPath: contribution.pluginRootPath,
            sourceSpec: contribution.sourceSpec,
            ...(contribution.generatedUiArtifactsManifest
                ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
                : {}),
            definition: contribution.definition,
        });
    }

    const agents = agentCandidates;
    return {
        introspectionContributions: collectNormalizedRegistryIntrospectionCandidates(pluginRegistry),
        uiViewsV2: Object.freeze(uiViewV2Candidates),
        uiRenderersV2: Object.freeze(uiRendererV2Candidates),
        uiTranslationsV2: Object.freeze(uiTranslationV2Candidates),
        agents: Object.freeze(agents),
        providers: Object.freeze(providerCandidates),
        actions: Object.freeze(actionCandidates),
        tools: Object.freeze(toolCandidates),
        commands: Object.freeze(commandCandidates),
        resources: Object.freeze(resourceCandidates),
        promptAssets: Object.freeze(promptAssetCandidates),
        uiTranslations: Object.freeze(uiTranslationCandidates),
        structuredMessages: Object.freeze(structuredMessageCandidates),
        sessionHeaderActions: Object.freeze(sessionHeaderActionCandidates),
        surfacePlacements: Object.freeze(surfacePlacementCandidates),
        hostedWeb: Object.freeze(hostedWebCandidates),
        reactNativeBundles: Object.freeze(reactNativeBundleCandidates),
        uiArtifacts: Object.freeze(uiArtifactCandidates),
        browserTargets: Object.freeze(browserTargetCandidates),
        browserActions: Object.freeze(browserActionCandidates),
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
        managedDependencies: Object.freeze(managedDependencyCandidates),
        systemTools: Object.freeze(systemToolCandidates),
        requestInterceptors: Object.freeze(requestInterceptorCandidates),
        voiceModelPacks: Object.freeze(voiceModelPackCandidates),
        voiceProviders: Object.freeze(voiceProviderCandidates),
        activationTargets: Object.freeze(activationTargets),
        pluginDiagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    };
}
