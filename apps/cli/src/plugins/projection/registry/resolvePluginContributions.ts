import { loadInstalledPlugins } from '../../discovery/load/installed';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import { buildPluginContributionRegistry } from './normalize/package';
import { loadBundledPluginLocators } from './builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPluginManifests';
import { collectNormalizedRegistryIntrospectionCandidates } from '@/plugins/projection/introspection/normalizedRegistry';
import { resolveContributedAgentRoutingId } from './agentRoutingIdentity';
import { projectManifestAgentContribution } from './projectManifestAgentContribution';

import type {
    ResolvedActionContribution,
    ResolvedAccountCollectionContribution,
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
    ResolvedMcpDiscoverySourceContribution,
    ResolvedMcpServerContribution,
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
    ResolvedOpenableContentViewerContribution,
    ResolvedProviderContribution,
    ResolvedPromptAssetContribution,
    ResolvedRequestInterceptorContribution,
    ResolvedScmBackendContribution,
    ResolvedSettingsContribution,
    ResolvedScmHostingProviderContribution,
    ResolvedAgentContribution,
    ResolvedResourceContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedTranscriptActivityContribution,
    ResolvedSessionInfoSectionContribution,
    ResolvedSystemToolContribution,
    ResolvedToolContribution,
    ResolvedUiTranslationsContribution,
    ResolvedUiRendererV2Contribution,
    ResolvedUiSettingsGroupV2Contribution,
    ResolvedUiSettingsPageV2Contribution,
    ResolvedUiTranslationBundleV2Contribution,
    ResolvedUiViewV2Contribution,
    ResolvedComposerAttachmentContribution,
    ResolvedComposerReferenceContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedActivationTarget,
    ResolvedVoiceModelPackContribution,
    ResolvedVoiceProviderContribution,
    ResolvedPluginContributionPointDeclaration,
    ResolvedTargetedPluginContributionDeclaration,
} from './types';

type ResolvePluginContributesParams = Readonly<{
    happyHomeDir?: string;
    existingAgentIds?: ReadonlySet<string>;
}>;

type PluginResolvedProviderContribution = ResolvedProviderContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
}>;

type PluginResolvedActionContribution = ResolvedActionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    identity: NonNullable<ResolvedActionContribution['identity']>;
    pluginRootPath: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedToolContribution = ResolvedToolContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedCommandContribution = ResolvedCommandContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedResourceContribution = ResolvedResourceContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    pluginRootPath: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedPromptAssetContribution = ResolvedPromptAssetContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
}>;

type PluginResolvedUiTranslationsContribution = ResolvedUiTranslationsContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSessionHeaderActionContribution = ResolvedSessionHeaderActionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedTranscriptActivityContribution = ResolvedTranscriptActivityContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;
type PluginResolvedSessionInfoSectionContribution = ResolvedSessionInfoSectionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedHostedWebContribution = ResolvedHostedWebContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedBrowserTargetContribution = ResolvedBrowserTargetContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedBrowserActionContribution = ResolvedBrowserActionContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedNotificationCategoryContribution = ResolvedNotificationCategoryContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedNotificationChannelContribution = ResolvedNotificationChannelContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedEventContribution = ResolvedEventContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSettingsContribution = ResolvedSettingsContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedExecutionRunProfileContribution = ResolvedExecutionRunProfileContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedMcpServerContribution = ResolvedMcpServerContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedMcpDiscoverySourceContribution = ResolvedMcpDiscoverySourceContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedInstallableContribution = ResolvedInstallableContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedSystemToolContribution = ResolvedSystemToolContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedRequestInterceptorContribution = ResolvedRequestInterceptorContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedConnectedAccountDescriptorContribution =
    ResolvedConnectedAccountDescriptorContribution & Readonly<{
        provenance: ResolvedContributionProvenance;
        pluginId: string;
        manifestPath: string;
        daemonEntryPath: string | null;
    }>;

type PluginResolvedScmHostingProviderContribution = ResolvedScmHostingProviderContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
}>;

type PluginResolvedScmBackendContribution = ResolvedScmBackendContribution & Readonly<{
    provenance: ResolvedContributionProvenance;
    pluginId: string;
    manifestPath: string;
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
    const openableContentViewerCandidates: ResolvedOpenableContentViewerContribution[] = [];
    const uiSettingsGroupV2Candidates: ResolvedUiSettingsGroupV2Contribution[] = [];
    const uiSettingsPageV2Candidates: ResolvedUiSettingsPageV2Contribution[] = [];
    const uiRendererV2Candidates: ResolvedUiRendererV2Contribution[] = [];
    const uiTranslationV2Candidates: ResolvedUiTranslationBundleV2Contribution[] = [];
    const composerReferenceCandidates: ResolvedComposerReferenceContribution[] = [];
    const composerAttachmentCandidates: ResolvedComposerAttachmentContribution[] = [];
    const composerControlCandidates: ResolvedComposerControlContribution[] = [];
    const composerRegionCandidates: ResolvedComposerRegionContribution[] = [];
    const agentCandidates: ResolvedAgentContribution[] = [];
    const providerCandidates: PluginResolvedProviderContribution[] = [];
    const actionCandidates: PluginResolvedActionContribution[] = [];
    const toolCandidates: PluginResolvedToolContribution[] = [];
    const commandCandidates: PluginResolvedCommandContribution[] = [];
    const resourceCandidates: PluginResolvedResourceContribution[] = [];
    const promptAssetCandidates: PluginResolvedPromptAssetContribution[] = [];
    const uiTranslationCandidates: PluginResolvedUiTranslationsContribution[] = [];
    const sessionHeaderActionCandidates: PluginResolvedSessionHeaderActionContribution[] = [];
    const transcriptActivityCandidates: PluginResolvedTranscriptActivityContribution[] = [];
    const sessionInfoSectionCandidates: PluginResolvedSessionInfoSectionContribution[] = [];
    const hostedWebCandidates: PluginResolvedHostedWebContribution[] = [];
    const browserTargetCandidates: PluginResolvedBrowserTargetContribution[] = [];
    const browserActionCandidates: PluginResolvedBrowserActionContribution[] = [];
    const settingsCandidates: PluginResolvedSettingsContribution[] = [];
    const notificationCandidates: PluginResolvedNotificationCategoryContribution[] = [];
    const notificationChannelCandidates: PluginResolvedNotificationChannelContribution[] = [];
    const eventCandidates: PluginResolvedEventContribution[] = [];
    const executionRunProfileCandidates: PluginResolvedExecutionRunProfileContribution[] = [];
    const mcpServerCandidates: PluginResolvedMcpServerContribution[] = [];
    const mcpDiscoverySourceCandidates: PluginResolvedMcpDiscoverySourceContribution[] = [];
    const scmHostingProviderCandidates: PluginResolvedScmHostingProviderContribution[] = [];
    const scmBackendCandidates: PluginResolvedScmBackendContribution[] = [];
    const connectedAccountDescriptorCandidates: PluginResolvedConnectedAccountDescriptorContribution[] = [];
    const managedDependencyCandidates: PluginResolvedInstallableContribution[] = [];
    const systemToolCandidates: PluginResolvedSystemToolContribution[] = [];
    const requestInterceptorCandidates: PluginResolvedRequestInterceptorContribution[] = [];
    const voiceModelPackCandidates: ResolvedVoiceModelPackContribution[] = [];
    const voiceProviderCandidates: ResolvedVoiceProviderContribution[] = [];
    const accountCollectionCandidates: ResolvedAccountCollectionContribution[] = [];
    const pluginContributionPointCandidates: ResolvedPluginContributionPointDeclaration[] = [];
    const targetedPluginContributionCandidates: ResolvedTargetedPluginContributionDeclaration[] = [];

    for (const contribution of pluginRegistry.uiViewsV2) {
      uiViewV2Candidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
      });
    }
    for (const contribution of pluginRegistry.openableContentViewers) {
        openableContentViewerCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.uiSettingsGroupsV2) {
        uiSettingsGroupV2Candidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.uiSettingsPagesV2) {
        uiSettingsPageV2Candidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
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
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.composerReferences) {
        composerReferenceCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.composerAttachments) {
        composerAttachmentCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.composerControls) {
        composerControlCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.composerRegions) {
        composerRegionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
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
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.pluginContributionPoints) {
        pluginContributionPointCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.targetedPluginContributions) {
        targetedPluginContributionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
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
            daemonEntryPath: plugin.daemonEntryPath,
            devDaemonEntryPath: plugin.devDaemonEntryPath,
            sourceSpec: plugin.sourceSpec,
            activationEvents: plugin.manifest.activation?.events.map((event) => event.kind) ?? [],
            manifest: plugin.manifest,
        });
    }

    for (const contribution of pluginRegistry.agents) {
        const localId = contribution.definition.id;
        // Durable Agent identity is `{pluginId, localId}`; two plugins declaring
        // the same natural local id are distinct Agents, so the uniqueness rule
        // is over the routing id the projection assigns, not the local id.
        const agentId = resolveContributedAgentRoutingId({
            pluginId: contribution.pluginId,
            localId,
            provenance: params.provenance,
        });
        if (knownAgentIds.has(agentId)) {
            appendDiagnostic(diagnosticsByPluginId, contribution.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin agent '${contribution.pluginId}/${localId}' collides with an existing agent routing id '${agentId}'`,
            });
            continue;
        }

        knownAgentIds.add(agentId);
        const loadedPlugin = loadResult.loadedPlugins.find((plugin) => (
            plugin.pluginId === contribution.pluginId
        ));
        const pluginHostAccess = loadedPlugin?.manifest.hostAccess;
        if (!pluginHostAccess) {
            throw new Error(`Missing cold-manifest host access for Agent '${contribution.pluginId}/${localId}'`);
        }
        agentCandidates.push(projectManifestAgentContribution({
            definition: contribution.definition,
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            // The Agent's declared CLI system-tool binding names a tool from the
            // same plugin's `systemTools` family, so the registry projection is
            // the one place that can resolve it.
            systemTools: loadedPlugin?.manifest.contributes.systemTools ?? [],
            sourceSpec: contribution.sourceSpec,
            hostAccess: pluginHostAccess,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
        }));
    }

    for (const contribution of pluginRegistry.actions) {
        actionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            pluginRootPath: contribution.pluginRootPath,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            ...(contribution.generatedUiArtifactsManifest
                ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
                : {}),
            ...(contribution.localizedPresentation
                ? { localizedPresentation: contribution.localizedPresentation }
                : {}),
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.tools) {
        toolCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
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
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.transcriptActivities) {
        transcriptActivityCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.sessionInfoSections) {
        sessionInfoSectionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.hostedWeb) {
        hostedWebCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
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
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.mcpDiscoverySources) {
        mcpDiscoverySourceCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
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
            pluginRootPath: contribution.pluginRootPath,
            sourceSpec: contribution.sourceSpec,
            ...(contribution.generatedUiArtifactsManifest
                ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
                : {}),
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.accountCollections) {
        accountCollectionCandidates.push({
            provenance: params.provenance,
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }

    const agents = agentCandidates;
    const materializationIdsByPluginId = Object.freeze(Object.fromEntries(
        loadResult.loadedPlugins.flatMap((plugin) => {
            const materializationId = loadResult.materializationIdsByPluginId?.[plugin.pluginId];
            return typeof materializationId === 'string' && materializationId.trim().length > 0
                ? [[plugin.pluginId, materializationId] as const]
                : [];
        }),
    ));
    return {
        introspectionContributions: collectNormalizedRegistryIntrospectionCandidates(pluginRegistry),
        uiViewsV2: Object.freeze(uiViewV2Candidates),
        openableContentViewers: Object.freeze(openableContentViewerCandidates),
        uiSettingsGroupsV2: Object.freeze(uiSettingsGroupV2Candidates),
        uiSettingsPagesV2: Object.freeze(uiSettingsPageV2Candidates),
        uiRenderersV2: Object.freeze(uiRendererV2Candidates),
        uiTranslationsV2: Object.freeze(uiTranslationV2Candidates),
        composerReferences: Object.freeze(composerReferenceCandidates),
        composerAttachments: Object.freeze(composerAttachmentCandidates),
        composerControls: Object.freeze(composerControlCandidates),
        composerRegions: Object.freeze(composerRegionCandidates),
        agents: Object.freeze(agents),
        providers: Object.freeze(providerCandidates),
        actions: Object.freeze(actionCandidates),
        tools: Object.freeze(toolCandidates),
        commands: Object.freeze(commandCandidates),
        resources: Object.freeze(resourceCandidates),
        promptAssets: Object.freeze(promptAssetCandidates),
        uiTranslations: Object.freeze(uiTranslationCandidates),
        sessionHeaderActions: Object.freeze(sessionHeaderActionCandidates),
        transcriptActivities: Object.freeze(transcriptActivityCandidates),
        sessionInfoSections: Object.freeze(sessionInfoSectionCandidates),
        hostedWeb: Object.freeze(hostedWebCandidates),
        browserTargets: Object.freeze(browserTargetCandidates),
        browserActions: Object.freeze(browserActionCandidates),
        settings: Object.freeze(settingsCandidates),
        notifications: Object.freeze(notificationCandidates),
        notificationChannels: Object.freeze(notificationChannelCandidates),
        events: Object.freeze(eventCandidates),
        executionRunProfiles: Object.freeze(executionRunProfileCandidates),
        mcpServers: Object.freeze(mcpServerCandidates),
        mcpDiscoverySources: Object.freeze(mcpDiscoverySourceCandidates),
        scmHostingProviders: Object.freeze(scmHostingProviderCandidates),
        scmBackends: Object.freeze(scmBackendCandidates),
        connectedAccountDescriptors: Object.freeze(connectedAccountDescriptorCandidates),
        managedDependencies: Object.freeze(managedDependencyCandidates),
        systemTools: Object.freeze(systemToolCandidates),
        requestInterceptors: Object.freeze(requestInterceptorCandidates),
        voiceModelPacks: Object.freeze(voiceModelPackCandidates),
        voiceProviders: Object.freeze(voiceProviderCandidates),
        accountCollections: Object.freeze(accountCollectionCandidates),
        pluginContributionPoints: Object.freeze(pluginContributionPointCandidates),
        targetedPluginContributions: Object.freeze(targetedPluginContributionCandidates),
        activationTargets: Object.freeze(activationTargets),
        materializationIdsByPluginId,
        pluginDiagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    };
}
