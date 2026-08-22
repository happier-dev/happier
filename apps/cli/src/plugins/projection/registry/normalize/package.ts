import type {
  ActionDefinitionV1,
  PluginAgentContributionV2,
  PluginBrowserActionContributionV1,
  PluginBrowserTargetContributionV1,
  PluginActionContributionV2,
  PluginAccountCollectionContributionV1,
  PluginCommandContributionV2,
  PluginExecutionRunProfileContributionV2,
  PluginEventContributionV1,
  PluginHookContributionV2,
  PluginHostedWebContributionV1,
  PluginMcpDiscoverySourceContributionV1,
  PluginMcpServerContributionV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginOpenableContentViewerContributionV1,
  PluginPromptAssetContributionV1,
  PluginRequestInterceptorContributionV1,
  PluginResourceContributionV2,
  PluginDynamicResourceContributionV2,
  PluginPackagedResourceContributionV2,
  PluginSessionHeaderActionDescriptorV1,
  PluginTranscriptActivityContributionV1,
  PluginSettingsContributionV2,
  PluginSystemToolContributionV1,
  ScmHostingProviderContribution,
  PluginConnectedAccountDescriptorContributionV2,
  PluginSourceSpecV1,
  PluginToolContributionV2,
  PluginUiTranslationsContributionV1,
  PluginUiRendererV2,
  PluginUiTranslationBundleV2,
  PluginUiViewV2,
  PluginManagedDependencyContributionV2,
  ScmBackendContribution,
  ProviderContributionV1,
  VoiceModelPackContributionV1,
  VoiceProviderContribution,
  NormalizedPluginAccountCollectionContractV1,
  PluginContributionPointV1,
  PluginTargetedContributionV1,
  PluginComposerReferenceProviderContributionV1,
  PluginComposerAttachmentContributionV1,
  PluginComposerControlContributionV1,
  PluginComposerRegionContributionV1,
} from '@happier-dev/protocol';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  isDynamicPluginResourceContributionV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  pluginActionRequiresConfirmationPresentation,
  normalizePluginActionInputHintsV2,
  normalizePluginActionSlashV2,
  normalizePluginAccountCollectionContractsV1,
  qualifyPluginEventIdV1,
  resolvePluginManifestSetReferencesV2,
} from '@happier-dev/protocol';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type {
  PluginUiArtifactsManifestV1,
  PluginUiSettingsGroupV1,
  PluginUiSettingsPageV1,
} from '@happier-dev/protocol/plugins/ui';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk';
import { resolvePluginResourcePath } from '../../resources/package/resolve';
import type {
  ResolvedCommandDefinition,
  ResolvedActionDefinition,
  ResolvedActionLocalizedPresentation,
  ResolvedEventDefinition,
  ResolvedResourceDefinition,
  ResolvedToolDefinition,
  PluginLocaleScopedIdentity,
} from '../types';

export type PluginOwnedContribution<T> = Readonly<{
  pluginId: string;
  pluginVersion?: string;
  identity?: PluginContributionIdentityV1;
  pluginRootPath: string;
  manifestPath: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath?: string | null;
  sourceSpec: PluginSourceSpecV1;
  definition: T;
}>;

export type PluginOwnedSemanticContribution = PluginOwnedContribution<unknown> & Readonly<{
  pluginVersion: string;
  family: string;
  conflictKey: string | null;
  introspection: ReturnType<(typeof PLUGIN_CONTRIBUTION_CATALOG_V2)[number]['projectIntrospection']>;
}>;

export type PluginOwnedLocaleContribution<T> = Readonly<
  Omit<PluginOwnedContribution<T>, 'identity'> & {
    localeIdentity: PluginLocaleScopedIdentity;
  }
>;

export type PluginOwnedUiRendererContribution = PluginOwnedContribution<PluginUiRendererV2> & Readonly<{
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
}>;

export type PluginOwnedVoiceProviderContribution = PluginOwnedContribution<VoiceProviderContribution> & Readonly<{
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
}>;

export type PluginOwnedActionContribution = PluginOwnedContribution<ResolvedActionDefinition> & Readonly<{
  /** The Action's client execution target resolves only through this signed graph. */
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
  /** Exact author presentation retained for the daemon/UI localization path. */
  localizedPresentation?: ResolvedActionLocalizedPresentation;
}>;

export type PluginOwnedContributionPoint = PluginOwnedContribution<PluginContributionPointV1> & Readonly<{
  /** Exact target-owned refs supplied only by a bundled `definePlugin` manifest. */
  semanticPointRefs?: readonly TargetedContributionPointRef<unknown>[];
}>;

export type PluginOwnedAccountCollectionContribution = PluginOwnedContribution<NormalizedPluginAccountCollectionContractV1>;
export type PluginOwnedOpenableContentViewerContribution = PluginOwnedContribution<PluginOpenableContentViewerContributionV1>;
export type PluginOwnedComposerReferenceContribution = PluginOwnedContribution<PluginComposerReferenceProviderContributionV1>;
export type PluginOwnedComposerAttachmentContribution = PluginOwnedContribution<PluginComposerAttachmentContributionV1>;
export type PluginOwnedComposerControlContribution = PluginOwnedContribution<PluginComposerControlContributionV1>;
export type PluginOwnedComposerRegionContribution = PluginOwnedContribution<PluginComposerRegionContributionV1>;

export type PluginContributionRegistry = Readonly<{
  semanticContributionsByFamily: ReadonlyMap<string, readonly PluginOwnedSemanticContribution[]>;
  uiViewsV2: readonly PluginOwnedContribution<PluginUiViewV2>[];
  openableContentViewers: readonly PluginOwnedOpenableContentViewerContribution[];
  uiRenderersV2: readonly PluginOwnedUiRendererContribution[];
  uiSettingsGroupsV2: readonly PluginOwnedContribution<PluginUiSettingsGroupV1>[];
  uiSettingsPagesV2: readonly PluginOwnedContribution<PluginUiSettingsPageV1>[];
  uiTranslationsV2: readonly PluginOwnedLocaleContribution<PluginUiTranslationBundleV2>[];
  composerReferences: readonly PluginOwnedComposerReferenceContribution[];
  composerAttachments: readonly PluginOwnedComposerAttachmentContribution[];
  composerControls: readonly PluginOwnedComposerControlContribution[];
  composerRegions: readonly PluginOwnedComposerRegionContribution[];
  agents: readonly PluginOwnedContribution<PluginAgentContributionV2>[];
  providers: readonly PluginOwnedContribution<ProviderContributionV1>[];
  actions: readonly PluginOwnedActionContribution[];
  tools: readonly PluginOwnedContribution<ResolvedToolDefinition>[];
  commands: readonly PluginOwnedContribution<ResolvedCommandDefinition>[];
  hooks: readonly PluginOwnedContribution<PluginHookContributionV2>[];
  resources: readonly PluginOwnedContribution<ResolvedResourceDefinition>[];
  promptAssets: readonly PluginOwnedContribution<PluginPromptAssetContributionV1>[];
  uiTranslations: readonly PluginOwnedContribution<PluginUiTranslationsContributionV1>[];
  sessionHeaderActions: readonly PluginOwnedContribution<PluginSessionHeaderActionDescriptorV1>[];
  transcriptActivities: readonly PluginOwnedContribution<PluginTranscriptActivityContributionV1>[];
  hostedWeb: readonly PluginOwnedContribution<PluginHostedWebContributionV1>[];
  browserTargets: readonly PluginOwnedContribution<PluginBrowserTargetContributionV1>[];
  browserActions: readonly PluginOwnedContribution<PluginBrowserActionContributionV1>[];
  settings: readonly PluginOwnedContribution<PluginSettingsContributionV2>[];
  notifications: readonly PluginOwnedContribution<PluginNotificationCategoryContributionV2>[];
  notificationChannels: readonly PluginOwnedContribution<PluginNotificationChannelContributionV2>[];
  events: readonly PluginOwnedContribution<ResolvedEventDefinition>[];
  executionRunProfiles: readonly PluginOwnedContribution<PluginExecutionRunProfileContributionV2>[];
  mcpServers: readonly PluginOwnedContribution<PluginMcpServerContributionV1>[];
  mcpDiscoverySources: readonly PluginOwnedContribution<PluginMcpDiscoverySourceContributionV1>[];
  scmHostingProviders: readonly PluginOwnedContribution<ScmHostingProviderContribution>[];
  scmBackends: readonly PluginOwnedContribution<ScmBackendContribution>[];
  connectedAccountDescriptors: readonly PluginOwnedContribution<PluginConnectedAccountDescriptorContributionV2>[];
  managedDependencies: readonly PluginOwnedContribution<PluginManagedDependencyContributionV2>[];
  systemTools: readonly PluginOwnedContribution<PluginSystemToolContributionV1>[];
  requestInterceptors: readonly PluginOwnedContribution<PluginRequestInterceptorContributionV1>[];
  voiceModelPacks: readonly PluginOwnedContribution<VoiceModelPackContributionV1>[];
  voiceProviders: readonly PluginOwnedVoiceProviderContribution[];
  accountCollections: readonly PluginOwnedAccountCollectionContribution[];
  pluginContributionPoints: readonly PluginOwnedContributionPoint[];
  targetedPluginContributions: readonly PluginOwnedContribution<PluginTargetedContributionV1>[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readContributionArray<T>(contributes: unknown, key: string): readonly T[] {
  if (!isRecord(contributes)) {
    return [];
  }
  const value = contributes[key];
  return Array.isArray(value) ? value as readonly T[] : [];
}

function displayText(value: string | Readonly<{ fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

function resolveReferenceKey(pluginId: string, reference: string | Readonly<{ pluginId: string; localId: string }>): string {
  return buildQualifiedPluginContributionKey(typeof reference === 'string'
    ? createPluginContributionIdentity({ pluginId, localId: reference })
    : createPluginContributionIdentity(reference));
}

function normalizeVoiceProviderDefinition(
  pluginId: string,
  definition: VoiceProviderContribution,
): VoiceProviderContribution {
  if (definition.kind !== 'conversation' || !definition.execution) return definition;
  const agent = definition.execution.agent;
  const execution = Object.freeze({
    ...definition.execution,
    agent: createPluginContributionIdentity(
      typeof agent === 'string' ? { pluginId, localId: agent } : agent,
    ),
  });
  const settings = definition.settings;
  if (!settings?.connectedServicesBinding) {
    return Object.freeze({ ...definition, execution });
  }
  const connectedServicesBinding = settings.connectedServicesBinding;
  const bindingAgent = createPluginContributionIdentity(
    typeof connectedServicesBinding.agent === 'string'
      ? { pluginId, localId: connectedServicesBinding.agent }
      : connectedServicesBinding.agent,
  );
  if (
    bindingAgent.pluginId !== execution.agent.pluginId
    || bindingAgent.localId !== execution.agent.localId
  ) {
    throw new Error(
      'Voice Connected Services binding Agent must match its Agent-session realtime execution Agent',
    );
  }
  return Object.freeze({
    ...definition,
    execution,
    settings: Object.freeze({
      ...settings,
      connectedServicesBinding: Object.freeze({
        ...connectedServicesBinding,
        agent: bindingAgent,
      }),
    }),
  });
}

function toActionDefinition(definition: PluginActionContributionV2): ResolvedActionDefinition {
  const kindVersion: ActionDefinitionV1['kindVersion'] = 1;
  const safety: ActionDefinitionV1['safety'] = definition.dangerLevel === 'safe' ? 'safe' : 'danger';
  const normalized = {
    kindVersion,
    id: definition.id,
    title: displayText(definition.title),
    ...(definition.icon ? { icon: definition.icon } : {}),
    description: definition.description ? displayText(definition.description) : null,
    safety,
    placements: [],
    slash: normalizePluginActionSlashV2(definition.slash),
    bindings: null,
    examples: null,
    execution: definition.execution,
    surfaces: {
      ui: definition.surfaces.includes('ui'),
      voice: definition.surfaces.includes('voice'),
      agent: definition.surfaces.includes('agent'),
      mcp: definition.surfaces.includes('mcp'),
      cli: definition.surfaces.includes('cli'),
      rpc: false,
      sdk: false,
      plugin: definition.surfaces.includes('plugin'),
    },
    inputHints: normalizePluginActionInputHintsV2(definition.inputHints) ?? null,
    inputSchema: definition.inputSchema ?? {},
    ...(definition.resultSchema ? { outputSchema: definition.resultSchema } : {}),
    scopes: definition.scopes,
    contributionSurfaces: definition.surfaces,
    ...(definition.placementBindings ? { placementBindings: [...definition.placementBindings] } : {}),
    availability: definition.availability,
    hostAccess: definition.hostAccess,
    priority: definition.priority,
  } satisfies Omit<ActionDefinitionV1, 'execution'> & Readonly<{
    execution: PluginActionContributionV2['execution'];
  }>;
  if (definition.dangerLevel === 'safe') {
    return Object.freeze({ ...normalized, safety: 'safe', dangerLevel: 'safe' });
  }
  if (pluginActionRequiresConfirmationPresentation(definition.surfaces, definition.dangerLevel) && !definition.confirmation) {
    throw new Error(`Non-safe plugin action '${definition.id}' has no confirmation metadata after manifest normalization`);
  }
  return Object.freeze({
    ...normalized,
    safety: 'danger',
    dangerLevel: definition.dangerLevel,
    ...(definition.confirmation ? { confirmation: definition.confirmation } : {}),
  });
}

function toActionLocalizedPresentation(
  definition: PluginActionContributionV2,
): ResolvedActionLocalizedPresentation {
  return Object.freeze({
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.inputHints === undefined ? {} : { inputHints: definition.inputHints }),
  });
}

function toToolDefinition(pluginId: string, definition: PluginToolContributionV2): ResolvedToolDefinition {
  return Object.freeze({
    ...definition,
    kindVersion: 1,
    actionId: resolveReferenceKey(pluginId, definition.action),
  });
}

function toCommandDefinition(pluginId: string, definition: PluginCommandContributionV2): ResolvedCommandDefinition {
  return Object.freeze({
    ...definition,
    kindVersion: 1,
    actionId: resolveReferenceKey(pluginId, definition.action),
  });
}

function toResourceDefinition(definition: PluginResourceContributionV2): ResolvedResourceDefinition {
  if (isDynamicPluginResourceContributionV2(definition)) {
    const dynamic = definition as PluginDynamicResourceContributionV2;
    return Object.freeze({
      kindVersion: 1,
      id: dynamic.id,
      type: dynamic.kind,
      source: 'dynamic',
      contentType: dynamic.contentType,
      scope: dynamic.scope,
      ...(dynamic.hostAccess === undefined ? {} : { hostAccess: Object.freeze([...dynamic.hostAccess]) }),
      ...(dynamic.maxBytes === undefined ? {} : { maxBytes: dynamic.maxBytes }),
    });
  }
  const packaged = definition as PluginPackagedResourceContributionV2;
  return Object.freeze({
    kindVersion: 1,
    id: packaged.id,
    type: packaged.kind,
    source: 'packaged',
    path: packaged.path,
    ...(packaged.digest ? { digest: packaged.digest } : {}),
    ...(packaged.contentType ? { contentType: packaged.contentType } : {}),
  });
}

function toEventDefinition(pluginId: string, definition: PluginEventContributionV1): ResolvedEventDefinition {
  return Object.freeze({
    ...definition,
    id: qualifyPluginEventIdV1(pluginId, definition.id),
    localId: definition.id,
  });
}

export function buildPluginContributionRegistry(params: Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  referencePlugins?: readonly LoadedPlugin[];
}>): PluginContributionRegistry {
  const referencePlugins = params.referencePlugins ?? [];
  const validationPlugins = [...referencePlugins, ...params.loadedPlugins];
  const seenPluginIds = new Set<string>();
  for (const plugin of validationPlugins) {
    if (seenPluginIds.has(plugin.pluginId)) {
      throw new Error(`Duplicate plugin identity '${plugin.pluginId}' in contribution reference universe`);
    }
    seenPluginIds.add(plugin.pluginId);
  }
  const referenceUniverseResolution = resolvePluginManifestSetReferencesV2(
    referencePlugins.map((plugin) => plugin.manifest),
  );
  if (!referenceUniverseResolution.ok) {
    throw new Error(`Invalid cross-plugin contribution reference: ${referenceUniverseResolution.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
  }
  const referenceResolution = resolvePluginManifestSetReferencesV2(
    validationPlugins.map((plugin) => plugin.manifest),
  );
  if (!referenceResolution.ok) {
    throw new Error(`Invalid cross-plugin contribution reference: ${referenceResolution.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
  }
  const semanticContributionsByFamily = new Map<string, PluginOwnedSemanticContribution[]>();
  const uiViewsV2: PluginOwnedContribution<PluginUiViewV2>[] = [];
  const openableContentViewers: PluginOwnedOpenableContentViewerContribution[] = [];
  const uiRenderersV2: PluginOwnedUiRendererContribution[] = [];
  const uiSettingsGroupsV2: PluginOwnedContribution<PluginUiSettingsGroupV1>[] = [];
  const uiSettingsPagesV2: PluginOwnedContribution<PluginUiSettingsPageV1>[] = [];
  const uiTranslationsV2: PluginOwnedLocaleContribution<PluginUiTranslationBundleV2>[] = [];
  const agents: PluginOwnedContribution<PluginAgentContributionV2>[] = [];
  const providers: PluginOwnedContribution<ProviderContributionV1>[] = [];
  const actions: PluginOwnedActionContribution[] = [];
  const tools: PluginOwnedContribution<ResolvedToolDefinition>[] = [];
  const commands: PluginOwnedContribution<ResolvedCommandDefinition>[] = [];
  const hooks: PluginOwnedContribution<PluginHookContributionV2>[] = [];
  const resources: PluginOwnedContribution<ResolvedResourceDefinition>[] = [];
  const promptAssets: PluginOwnedContribution<PluginPromptAssetContributionV1>[] = [];
  const uiTranslations: PluginOwnedContribution<PluginUiTranslationsContributionV1>[] = [];
  const sessionHeaderActions: PluginOwnedContribution<PluginSessionHeaderActionDescriptorV1>[] = [];
  const transcriptActivities: PluginOwnedContribution<PluginTranscriptActivityContributionV1>[] = [];
  const hostedWeb: PluginOwnedContribution<PluginHostedWebContributionV1>[] = [];
  const browserTargets: PluginOwnedContribution<PluginBrowserTargetContributionV1>[] = [];
  const browserActions: PluginOwnedContribution<PluginBrowserActionContributionV1>[] = [];
  const settings: PluginOwnedContribution<PluginSettingsContributionV2>[] = [];
  const notifications: PluginOwnedContribution<PluginNotificationCategoryContributionV2>[] = [];
  const notificationChannels: PluginOwnedContribution<PluginNotificationChannelContributionV2>[] = [];
  const events: PluginOwnedContribution<ResolvedEventDefinition>[] = [];
  const executionRunProfiles: PluginOwnedContribution<PluginExecutionRunProfileContributionV2>[] = [];
  const mcpServers: PluginOwnedContribution<PluginMcpServerContributionV1>[] = [];
  const mcpDiscoverySources: PluginOwnedContribution<PluginMcpDiscoverySourceContributionV1>[] = [];
  const scmHostingProviders: PluginOwnedContribution<ScmHostingProviderContribution>[] = [];
  const scmBackends: PluginOwnedContribution<ScmBackendContribution>[] = [];
  const connectedAccountDescriptors: PluginOwnedContribution<PluginConnectedAccountDescriptorContributionV2>[] = [];
  const managedDependencies: PluginOwnedContribution<PluginManagedDependencyContributionV2>[] = [];
  const systemTools: PluginOwnedContribution<PluginSystemToolContributionV1>[] = [];
  const requestInterceptors: PluginOwnedContribution<PluginRequestInterceptorContributionV1>[] = [];
  const voiceModelPacks: PluginOwnedContribution<VoiceModelPackContributionV1>[] = [];
  const voiceProviders: PluginOwnedVoiceProviderContribution[] = [];
  const accountCollections: PluginOwnedAccountCollectionContribution[] = [];
  const pluginContributionPoints: PluginOwnedContributionPoint[] = [];
  const targetedPluginContributions: PluginOwnedContribution<PluginTargetedContributionV1>[] = [];
  const composerReferences: PluginOwnedComposerReferenceContribution[] = [];
  const composerAttachments: PluginOwnedComposerAttachmentContribution[] = [];
  const composerControls: PluginOwnedComposerControlContribution[] = [];
  const composerRegions: PluginOwnedComposerRegionContribution[] = [];

  for (const plugin of params.loadedPlugins) {
    const semanticContributionsForPlugin = new Map<string, PluginOwnedSemanticContribution[]>();
    for (const catalogEntry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      for (const rawDefinition of catalogEntry.readEntries(plugin.manifest.contributes)) {
        const definition = catalogEntry.canonicalize(rawDefinition);
        if (!isRecord(definition)) continue;
        const introspection = catalogEntry.projectIntrospection(definition);
        const familyContributions = semanticContributionsByFamily.get(catalogEntry.manifestKey) ?? [];
        familyContributions.push(Object.freeze({
          pluginId: plugin.pluginId,
          pluginVersion: plugin.manifest.version,
          ...(introspection.localId
            ? { identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: introspection.localId }) }
            : {}),
          family: catalogEntry.manifestKey,
          conflictKey: catalogEntry.conflictKey(definition),
          introspection,
          pluginRootPath: plugin.pluginRootPath,
          manifestPath: plugin.manifestPath,
          daemonEntryPath: plugin.daemonEntryPath,
          devDaemonEntryPath: plugin.devDaemonEntryPath,
          sourceSpec: plugin.sourceSpec,
          definition,
        }));
        semanticContributionsByFamily.set(catalogEntry.manifestKey, familyContributions);
        const pluginFamilyContributions = semanticContributionsForPlugin.get(catalogEntry.manifestKey) ?? [];
        pluginFamilyContributions.push(familyContributions.at(-1)!);
        semanticContributionsForPlugin.set(catalogEntry.manifestKey, pluginFamilyContributions);
      }
    }
    const readSemanticDefinitions = <T>(family: string): readonly T[] => (
      semanticContributionsForPlugin.get(family)?.map((entry) => entry.definition as T) ?? []
    );

    for (const definition of readSemanticDefinitions<PluginContributionPointV1>('pluginContributionPoints')) {
      const semanticPointRefs = plugin.semanticPointRefs?.filter((point) => (
        point.targetPluginId === plugin.pluginId
        && point.id === definition.id
        && definition.protocols.some((protocol) => (
          protocol.id === point.protocol.id && protocol.version === point.protocol.version
        ))
      ));
      pluginContributionPoints.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
        ...(semanticPointRefs && semanticPointRefs.length > 0
          ? { semanticPointRefs: Object.freeze(semanticPointRefs) }
          : {}),
      });
    }
    for (const definition of readSemanticDefinitions<PluginTargetedContributionV1>('targetedPluginContributions')) {
      targetedPluginContributions.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginComposerReferenceProviderContributionV1>('composerReferences')) {
      composerReferences.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginComposerAttachmentContributionV1>('composerAttachments')) {
      composerAttachments.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginComposerControlContributionV1>('composerControls')) {
      composerControls.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginComposerRegionContributionV1>('composerRegions')) {
      composerRegions.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of normalizePluginAccountCollectionContractsV1({
      pluginId: plugin.pluginId,
      contributions: readSemanticDefinitions<PluginAccountCollectionContributionV1>('accountCollections'),
    })) {
      accountCollections.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({
          pluginId: plugin.pluginId,
          localId: definition.collectionId,
        }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginUiViewV2>('ui.views')) {
      uiViewsV2.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginOpenableContentViewerContributionV1>('openableContentViewers')) {
      openableContentViewers.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginUiRendererV2>('ui.renderers')) {
      uiRenderersV2.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        ...(plugin.generatedUiArtifactsManifest
          ? { generatedUiArtifactsManifest: plugin.generatedUiArtifactsManifest }
          : {}),
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginUiSettingsGroupV1>('ui.settingsGroups')) {
      uiSettingsGroupsV2.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginUiSettingsPageV1>('ui.settingsPages')) {
      uiSettingsPagesV2.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginUiTranslationBundleV2>('ui.translations')) {
      uiTranslationsV2.push({
        pluginId: plugin.pluginId,
        localeIdentity: { pluginId: plugin.pluginId, locale: definition.locale },
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }
    for (const definition of readSemanticDefinitions<PluginAgentContributionV2>('agents')) {
      agents.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<ProviderContributionV1>('providers')) {
      providers.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({
          pluginId: plugin.pluginId,
          localId: definition.id,
        }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginActionContributionV2>('actions')) {
      actions.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        ...(plugin.generatedUiArtifactsManifest
          ? { generatedUiArtifactsManifest: plugin.generatedUiArtifactsManifest }
          : {}),
        localizedPresentation: toActionLocalizedPresentation(definition),
        definition: toActionDefinition(definition),
      });
    }

    for (const definition of readSemanticDefinitions<PluginToolContributionV2>('tools')) {
      tools.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toToolDefinition(plugin.pluginId, definition),
      });
    }

    for (const definition of readSemanticDefinitions<PluginCommandContributionV2>('commands')) {
      commands.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toCommandDefinition(plugin.pluginId, definition),
      });
    }

    for (const definition of readSemanticDefinitions<PluginHookContributionV2>('hooks')) {
      hooks.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginResourceContributionV2>('resources')) {
      const normalized = toResourceDefinition(definition);
      const resourcePath = normalized.path;
      if (resourcePath) {
        const resolvedPath = resolvePluginResourcePath({
          pluginRootPath: plugin.pluginRootPath,
          resourcePath,
        });
        if (!resolvedPath) {
          continue;
        }
        resources.push({
          pluginId: plugin.pluginId,
          pluginRootPath: plugin.pluginRootPath,
          manifestPath: plugin.manifestPath,
          daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
          sourceSpec: plugin.sourceSpec,
          definition: Object.freeze({
            ...normalized,
            path: resolvedPath.relativePath,
          }),
        });
        continue;
      }
      resources.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: normalized,
      });
    }

    for (const definition of readContributionArray<PluginUiTranslationsContributionV1>(plugin.manifest.contributes, 'uiTranslations')) {
      uiTranslations.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginSessionHeaderActionDescriptorV1>('sessionHeaderActions')) {
      sessionHeaderActions.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginTranscriptActivityContributionV1>('transcriptActivities')) {
      transcriptActivities.push({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.manifest.version,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readContributionArray<PluginHostedWebContributionV1>(plugin.manifest.contributes, 'hostedWeb')) {
      hostedWeb.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginBrowserTargetContributionV1>('browserTargets')) {
      browserTargets.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginBrowserActionContributionV1>('browserActions')) {
      browserActions.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginSettingsContributionV2>('settings')) {
      settings.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginPromptAssetContributionV1>('promptAssets')) {
      promptAssets.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginNotificationCategoryContributionV2>('notifications')) {
      notifications.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginNotificationChannelContributionV2>('notificationChannels')) {
      notificationChannels.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginEventContributionV1>('events')) {
      events.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition: toEventDefinition(plugin.pluginId, definition),
      });
    }

    for (const definition of readSemanticDefinitions<PluginExecutionRunProfileContributionV2>('executionRunProfiles')) {
      executionRunProfiles.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginMcpServerContributionV1>('mcp.servers')) {
      mcpServers.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginMcpDiscoverySourceContributionV1>('mcp.discoverySources')) {
      mcpDiscoverySources.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<ScmHostingProviderContribution>('scmHostingProviders')) {
      scmHostingProviders.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({
          pluginId: plugin.pluginId,
          localId: definition.id,
        }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<ScmBackendContribution>('scmBackends')) {
      scmBackends.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({
          pluginId: plugin.pluginId,
          localId: definition.id,
        }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginConnectedAccountDescriptorContributionV2>('connectedAccountDescriptors')) {
      connectedAccountDescriptors.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginManagedDependencyContributionV2>('managedDependencies')) {
      managedDependencies.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginSystemToolContributionV1>('systemTools')) {
      systemTools.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<PluginRequestInterceptorContributionV1>('requestInterceptors')) {
      requestInterceptors.push({
        pluginId: plugin.pluginId,
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<VoiceModelPackContributionV1>('voiceModelPacks')) {
      voiceModelPacks.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        definition,
      });
    }

    for (const definition of readSemanticDefinitions<VoiceProviderContribution>('voiceProviders')) {
      voiceProviders.push({
        pluginId: plugin.pluginId,
        identity: createPluginContributionIdentity({ pluginId: plugin.pluginId, localId: definition.id }),
        pluginRootPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
        daemonEntryPath: plugin.daemonEntryPath,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
        sourceSpec: plugin.sourceSpec,
        ...(plugin.generatedUiArtifactsManifest
          ? { generatedUiArtifactsManifest: plugin.generatedUiArtifactsManifest }
          : {}),
        definition: normalizeVoiceProviderDefinition(plugin.pluginId, definition),
      });
    }


  }

  return Object.freeze({
    semanticContributionsByFamily: Object.freeze(new Map(
      [...semanticContributionsByFamily.entries()].map(([family, contributions]) => [family, Object.freeze(contributions)]),
    )),
    uiViewsV2: Object.freeze(uiViewsV2),
    openableContentViewers: Object.freeze(openableContentViewers),
    uiRenderersV2: Object.freeze(uiRenderersV2),
    uiSettingsGroupsV2: Object.freeze(uiSettingsGroupsV2),
    uiSettingsPagesV2: Object.freeze(uiSettingsPagesV2),
    uiTranslationsV2: Object.freeze(uiTranslationsV2),
    composerReferences: Object.freeze(composerReferences),
    composerAttachments: Object.freeze(composerAttachments),
    composerControls: Object.freeze(composerControls),
    composerRegions: Object.freeze(composerRegions),
    agents: Object.freeze(agents),
    providers: Object.freeze(providers),
    actions: Object.freeze(actions),
    tools: Object.freeze(tools),
    commands: Object.freeze(commands),
    hooks: Object.freeze(hooks),
    resources: Object.freeze(resources),
    promptAssets: Object.freeze(promptAssets),
    uiTranslations: Object.freeze(uiTranslations),
    sessionHeaderActions: Object.freeze(sessionHeaderActions),
    transcriptActivities: Object.freeze(transcriptActivities),
    hostedWeb: Object.freeze(hostedWeb),
    browserTargets: Object.freeze(browserTargets),
    browserActions: Object.freeze(browserActions),
    settings: Object.freeze(settings),
    notifications: Object.freeze(notifications),
    notificationChannels: Object.freeze(notificationChannels),
    events: Object.freeze(events),
    executionRunProfiles: Object.freeze(executionRunProfiles),
    mcpServers: Object.freeze(mcpServers),
    mcpDiscoverySources: Object.freeze(mcpDiscoverySources),
    scmHostingProviders: Object.freeze(scmHostingProviders),
    scmBackends: Object.freeze(scmBackends),
    connectedAccountDescriptors: Object.freeze(connectedAccountDescriptors),
    managedDependencies: Object.freeze(managedDependencies),
    systemTools: Object.freeze(systemTools),
    requestInterceptors: Object.freeze(requestInterceptors),
    voiceModelPacks: Object.freeze(voiceModelPacks),
    voiceProviders: Object.freeze(voiceProviders),
    accountCollections: Object.freeze(accountCollections),
    pluginContributionPoints: Object.freeze(pluginContributionPoints),
    targetedPluginContributions: Object.freeze(targetedPluginContributions),
  });
}
