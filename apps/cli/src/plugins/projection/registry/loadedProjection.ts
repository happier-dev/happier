import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { loadInstalledPlugins, type LoadedPlugin } from '../../discovery/load/installed';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import type { PluginContributionRegistry } from './normalize/registry';
import { loadCurrentBundledPluginLocatorResult } from './builtIn/locators';
import { collectNormalizedRegistryIntrospectionCandidates } from '@/plugins/projection/introspection/normalizedRegistry';
import { resolveContributedAgentRoutingId } from './agentRoutingIdentity';
import { projectManifestAgentContribution } from './projectManifestAgentContribution';
import { admitPluginContributionGraph, type AdmittedPluginContributionGraph } from './normalize/admission';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import type {
    ResolvedActionContribution,
    ResolvedAccountCollectionContribution,
    ResolvedBrowserActionContribution,
    ResolvedBrowserTargetContribution,
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedContributionInputs,
    ResolvedPluginEnablement,
    ResolvedContributionProvenance,
    ResolvedExecutionRunProfileContribution,
    ResolvedRoleContribution,
    ResolvedWorkflowContribution,
    ResolvedInputTypeContribution,
    ResolvedBotTemplateContribution,
    ResolvedAtmospherePictureContribution,
    ResolvedSoundContribution,
    ResolvedThemeContribution,
    ResolvedRegistrySourceContribution,
    ResolvedLanguageServerContribution,
    ResolvedSkillContribution,
    ResolvedMachineProvisionerContribution,
    ResolvedDragSourceContribution,
    ResolvedWorkItemsContribution,
    ResolvedDropTargetContribution,
    ResolvedEventContribution,
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
    ResolvedUiRendererV2Contribution,
    ResolvedUiSettingsGroupV2Contribution,
    ResolvedUiSettingsPageV2Contribution,
    ResolvedUiListExtensionV1Contribution,
    ResolvedUiTranslationBundleV2Contribution,
    ResolvedUiViewV2Contribution,
    ResolvedComposerAttachmentContribution,
    ResolvedComposerReferenceContribution,
    ResolvedSearchProviderContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedActivationTarget,
    ResolvedVoiceModelPackContribution,
    ResolvedVoiceProviderContribution,
    ResolvedPluginContributionPointDeclaration,
    ResolvedTargetedPluginContributionDeclaration,
} from './types';

export type ResolvePluginContributesParams = Readonly<{
    pluginIds?: readonly string[];
    happyHomeDir?: string;
    existingAgentIds?: ReadonlySet<string>;
    providerContributionKeys?: readonly string[];
    agentIdentity?: PluginContributionIdentityV1;
    referenceGraph?: AdmittedPluginContributionGraph;
    pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
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

export function projectLoadedPluginRegistry(
    params: Omit<ResolvePluginContributesParams, 'happyHomeDir'> & Readonly<{
        loadResult: Awaited<ReturnType<typeof loadInstalledPlugins>>;
        provenance: ResolvedContributionProvenance | ((plugin: Pick<LoadedPlugin, 'sourceSpec'>) => ResolvedContributionProvenance);
        pluginRegistry: PluginContributionRegistry;
        admittedGraph?: AdmittedPluginContributionGraph;
    }>,
): ResolvedContributionInputs {
    const pluginRegistry = params.pluginRegistry;
    const provenance = params.provenance;
    const readProvenance = typeof provenance === 'function' ? provenance : () => provenance;
    const loadResult = { ...params.loadResult, loadedPlugins: pluginRegistry.admittedGraph.loadedPlugins };
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const knownAgentIds = new Set(params.existingAgentIds ?? []);
    const uiViewV2Candidates: ResolvedUiViewV2Contribution[] = [];
    const openableContentViewerCandidates: ResolvedOpenableContentViewerContribution[] = [];
    const uiSettingsGroupV2Candidates: ResolvedUiSettingsGroupV2Contribution[] = [];
    const uiSettingsPageV2Candidates: ResolvedUiSettingsPageV2Contribution[] = [];
    const uiListExtensionV1Candidates: ResolvedUiListExtensionV1Contribution[] = [];
    const uiRendererV2Candidates: ResolvedUiRendererV2Contribution[] = [];
    const uiTranslationV2Candidates: ResolvedUiTranslationBundleV2Contribution[] = [];
    const composerReferenceCandidates: ResolvedComposerReferenceContribution[] = [];
    const searchProviderCandidates: ResolvedSearchProviderContribution[] = [];
    const composerAttachmentCandidates: ResolvedComposerAttachmentContribution[] = [];
    const composerControlCandidates: ResolvedComposerControlContribution[] = [];
    const composerRegionCandidates: ResolvedComposerRegionContribution[] = [];
    const agentCandidates: ResolvedAgentContribution[] = [];
    const providerCandidates: PluginResolvedProviderContribution[] = [];
    const actionCandidates: PluginResolvedActionContribution[] = [];
    const resourceCandidates: PluginResolvedResourceContribution[] = [];
    const promptAssetCandidates: PluginResolvedPromptAssetContribution[] = [];
    const sessionHeaderActionCandidates: PluginResolvedSessionHeaderActionContribution[] = [];
    const transcriptActivityCandidates: PluginResolvedTranscriptActivityContribution[] = [];
    const sessionInfoSectionCandidates: PluginResolvedSessionInfoSectionContribution[] = [];
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
    const roleCandidates: ResolvedRoleContribution[] = [];
    const workflowCandidates: ResolvedWorkflowContribution[] = [];
    const botTemplateCandidates: ResolvedBotTemplateContribution[] = [];
    const inputTypeCandidates: ResolvedInputTypeContribution[] = [];
    const atmospherePictureCandidates: ResolvedAtmospherePictureContribution[] = [];
    const soundCandidates: ResolvedSoundContribution[] = [];
    const themeCandidates: ResolvedThemeContribution[] = [];
    const registrySourceCandidates: ResolvedRegistrySourceContribution[] = [];
    const backupDestinationCandidates: import('./types').ResolvedBackupDestinationContribution[] = [];
    const machineRoleCandidates: import('./types').ResolvedMachineRoleContribution[] = [];
    const deploymentTargetCandidates: import('./types').ResolvedDeploymentTargetContribution[] = [];
    const subjectKindCandidates: import('./types').ResolvedSubjectKindContribution[] = [];
    const healthCheckKindCandidates: import('./types').ResolvedHealthCheckKindContribution[] = [];
    const storeKindCandidates: import('./types').ResolvedStoreKindContribution[] = [];
    const machineRecipeCandidates: import('./types').ResolvedMachineRecipeContribution[] = [];
    const machineSetupPresetCandidates: import('./types').ResolvedMachineSetupPresetContribution[] = [];
    const languageServerCandidates: ResolvedLanguageServerContribution[] = [];
    const skillCandidates: ResolvedSkillContribution[] = [];
    const accessProviderCandidates: import('./types').ResolvedAccessProviderContribution[] = [];
    const machineProvisionerCandidates: ResolvedMachineProvisionerContribution[] = [];
    const dragSourceCandidates: ResolvedDragSourceContribution[] = [];
    const workItemCandidates: ResolvedWorkItemsContribution[] = [];
    const dropTargetCandidates: ResolvedDropTargetContribution[] = [];
    const voiceProviderCandidates: ResolvedVoiceProviderContribution[] = [];
    const accountCollectionCandidates: ResolvedAccountCollectionContribution[] = [];
    const pluginContributionPointCandidates: ResolvedPluginContributionPointDeclaration[] = [];
    const targetedPluginContributionCandidates: ResolvedTargetedPluginContributionDeclaration[] = [];

    for (const contribution of pluginRegistry.uiViewsV2) {
      uiViewV2Candidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.uiListExtensionsV1) {
        uiListExtensionV1Candidates.push({
            provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!, manifestPath: contribution.manifestPath, definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.uiRenderersV2) {
        uiRendererV2Candidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            localeIdentity: contribution.localeIdentity,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.composerReferences) {
        composerReferenceCandidates.push({
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }
    for (const contribution of pluginRegistry.searchProviders) {
        searchProviderCandidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
    for (const [pluginId, diagnostics] of Object.entries(pluginRegistry.admittedGraph.diagnosticsByPluginId)) {
        diagnosticsByPluginId[pluginId] = [...(diagnosticsByPluginId[pluginId] ?? []), ...diagnostics];
    }

    for (const plugin of loadResult.loadedPlugins) {
        if (plugin.admissionDiagnostics?.length) {
            diagnosticsByPluginId[plugin.pluginId] = [...new Set([
                ...(diagnosticsByPluginId[plugin.pluginId] ?? []), ...plugin.admissionDiagnostics,
            ])];
        }
        if (!plugin.daemonEntryPath && !plugin.devDaemonEntryPath) {
            continue;
        }
        activationTargets.push({
            provenance: readProvenance(plugin),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            admittedTarget: contribution.admittedTarget,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.resources) {
        resourceCandidates.push({
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            ...(contribution.generatedUiArtifactsManifest ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest } : {}),
            pluginRootPath: contribution.pluginRootPath,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.sessionHeaderActions) {
        sessionHeaderActionCandidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.browserTargets) {
        browserTargetCandidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.notificationChannels) {
        notificationChannelCandidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            pluginRootPath: contribution.pluginRootPath,
            ...(contribution.generatedUiArtifactsManifest ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest } : {}),
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.managedDependencies) {
        managedDependencyCandidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.requestInterceptors) {
        requestInterceptorCandidates.push({
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            manifestPath: contribution.manifestPath,
            daemonEntryPath: contribution.daemonEntryPath,
            devDaemonEntryPath: contribution.devDaemonEntryPath,
            sourceSpec: contribution.sourceSpec,
            definition: contribution.definition,
      });
    }

    for (const contribution of pluginRegistry.roles) {
        roleCandidates.push({
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            displayName: contribution.displayName,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.workflows) {
        workflowCandidates.push({
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.botTemplates) {
        botTemplateCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.inputTypes) {
        inputTypeCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.machineRecipes) {
        machineRecipeCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.machineSetupPresets) {
        machineSetupPresetCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.deploymentTargets) {
        deploymentTargetCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.subjectKinds) {
        subjectKindCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.healthCheckKinds) {
        healthCheckKindCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.storeKinds) {
        storeKindCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.backupDestinations) {
        backupDestinationCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.machineRoles) {
        machineRoleCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.registrySources) {
        registrySourceCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            pluginRootPath: contribution.pluginRootPath, manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.languageServers) {
        languageServerCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.skills) {
        const pluginName = params.loadResult.loadedPlugins.find(plugin => plugin.manifest.id === contribution.pluginId)?.manifest.displayName;
        skillCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            pluginRootPath: contribution.pluginRootPath, manifestPath: contribution.manifestPath,
            ...(typeof pluginName === 'string' ? { pluginName } : {}), definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.atmospherePictures) {
        atmospherePictureCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    for (const contribution of pluginRegistry.sounds) {
        soundCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }
    const pluginNames = new Map(params.loadResult.loadedPlugins.map(plugin => [plugin.pluginId,
        resolvePluginLocalizedStringV2Text(plugin.manifest.displayName)]));
    for (const contribution of pluginRegistry.themes) {
        themeCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            pluginName: pluginNames.get(contribution.pluginId),
            manifestPath: contribution.manifestPath, definition: contribution.definition });
    }

    for (const contribution of pluginRegistry.accessProviders) {
        accessProviderCandidates.push({
            provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!, manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.machineProvisioners) {
        machineProvisionerCandidates.push({
            provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!, manifestPath: contribution.manifestPath,
            definition: contribution.definition,
        });
    }

    for (const contribution of pluginRegistry.workItems) {
        workItemCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, pluginRootPath: contribution.pluginRootPath, definition: contribution.definition,
            ...(contribution.generatedUiArtifactsManifest ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest } : {}) });
    }
    for (const contribution of pluginRegistry.dragSources) {
        dragSourceCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, pluginRootPath: contribution.pluginRootPath, definition: contribution.definition,
            ...(contribution.generatedUiArtifactsManifest ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest } : {}) });
    }
    for (const contribution of pluginRegistry.dropTargets) {
        dropTargetCandidates.push({ provenance: readProvenance(contribution), source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId, pluginVersion: contribution.pluginVersion, identity: contribution.identity!,
            manifestPath: contribution.manifestPath, pluginRootPath: contribution.pluginRootPath, definition: contribution.definition,
            ...(contribution.generatedUiArtifactsManifest ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest } : {}) });
    }

    for (const contribution of pluginRegistry.voiceModelPacks) {
        voiceModelPackCandidates.push({
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
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
            provenance: readProvenance(contribution),
            source: { kind: contribution.sourceSpec.kind },
            pluginId: contribution.pluginId,
            pluginVersion: contribution.pluginVersion,
            identity: contribution.identity!,
            manifestPath: contribution.manifestPath,
            pluginRootPath: contribution.pluginRootPath,
            ...(contribution.generatedUiArtifactsManifest
                ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
                : {}),
            ...(contribution.migrationArtifact
                ? { migrationArtifact: contribution.migrationArtifact }
                : {}),
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
        pluginDeclarations: Object.freeze([...loadResult.loadedPlugins]),
        unavailablePlugins: pluginRegistry.admittedGraph.unavailablePlugins,
        uiViewsV2: Object.freeze(uiViewV2Candidates),
        openableContentViewers: Object.freeze(openableContentViewerCandidates),
        uiSettingsGroupsV2: Object.freeze(uiSettingsGroupV2Candidates),
        uiSettingsPagesV2: Object.freeze(uiSettingsPageV2Candidates),
        uiListExtensionsV1: Object.freeze(uiListExtensionV1Candidates),
        uiRenderersV2: Object.freeze(uiRendererV2Candidates),
        uiTranslationsV2: Object.freeze(uiTranslationV2Candidates),
        composerReferences: Object.freeze(composerReferenceCandidates),
        searchProviders: Object.freeze(searchProviderCandidates),
        composerAttachments: Object.freeze(composerAttachmentCandidates),
        composerControls: Object.freeze(composerControlCandidates),
        composerRegions: Object.freeze(composerRegionCandidates),
        agents: Object.freeze(agents),
        providers: Object.freeze(providerCandidates),
        actions: Object.freeze(actionCandidates),
        resources: Object.freeze(resourceCandidates),
        promptAssets: Object.freeze(promptAssetCandidates),
        sessionHeaderActions: Object.freeze(sessionHeaderActionCandidates),
        transcriptActivities: Object.freeze(transcriptActivityCandidates),
        sessionInfoSections: Object.freeze(sessionInfoSectionCandidates),
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
        roles: Object.freeze(roleCandidates),
        workflows: Object.freeze(workflowCandidates),
        botTemplates: Object.freeze(botTemplateCandidates),
        inputTypes: Object.freeze(inputTypeCandidates),
        atmospherePictures: Object.freeze(atmospherePictureCandidates),
        sounds: Object.freeze(soundCandidates),
        themes: Object.freeze(themeCandidates),
        registrySources: Object.freeze(registrySourceCandidates),
        backupDestinations: Object.freeze(backupDestinationCandidates),
        machineRoles: Object.freeze(machineRoleCandidates),
        deploymentTargets: Object.freeze(deploymentTargetCandidates),
        subjectKinds: Object.freeze(subjectKindCandidates),
        healthCheckKinds: Object.freeze(healthCheckKindCandidates),
        storeKinds: Object.freeze(storeKindCandidates),
        machineRecipes: Object.freeze(machineRecipeCandidates),
        machineSetupPresets: Object.freeze(machineSetupPresetCandidates),
        languageServers: Object.freeze(languageServerCandidates),
        skills: Object.freeze(skillCandidates),
        accessProviders: Object.freeze(accessProviderCandidates),
        machineProvisioners: Object.freeze(machineProvisionerCandidates),
        dragSources: Object.freeze(dragSourceCandidates),
        workItems: Object.freeze(workItemCandidates),
        dropTargets: Object.freeze(dropTargetCandidates),
        voiceProviders: Object.freeze(voiceProviderCandidates),
        accountCollections: Object.freeze(accountCollectionCandidates),
        pluginContributionPoints: Object.freeze(pluginContributionPointCandidates),
        targetedPluginContributions: Object.freeze(targetedPluginContributionCandidates),
        activationTargets: Object.freeze(activationTargets),
        materializationIdsByPluginId,
        pluginDiagnosticsByPluginId: Object.freeze(diagnosticsByPluginId),
    };
}
