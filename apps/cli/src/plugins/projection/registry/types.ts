import type {
    BackendCatalogDefinition,
    ProviderCatalogDefinition as AgentCatalogDefinition,
    BackendDefinitionContractV1,
    ProviderDefinitionContractV1 as AgentDefinitionContractV1,
} from '@happier-dev/agents';
import type {
  ActionDefinitionV1,
  AgentDefinitionV1,
  BackendDefinitionV1,
  BackendSurfaceDeclarationV1,
  PluginBackendCapabilitiesV1,
  PluginBrowserActionContributionV1,
  PluginBrowserTargetContributionV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginExecutionRunProfileContributionV2,
  PluginHostedWebContributionV1,
  PluginEmbeddedWebBundleContributionV1,
  PluginReactNativeBundleContributionV1,
  PluginSessionHeaderActionDescriptorV1,
  PluginSurfacePlacementDescriptorV1,
  PluginMcpDiscoveryProviderContributionV1,
  PluginMcpServerContributionV1,
  PluginRequestInterceptorContributionV1,
  InstallableDependencyDescriptor,
  ScmBackendContribution,
  PluginSettingsContributionV2,
  PluginStructuredMessageDescriptorV1,
  PluginUiArtifactContributionV1,
  ScmHostingProviderContribution,
  PluginConnectedAccountDescriptorContributionV2,
  PluginEventContributionV1,
  PluginSourceSpecV1,
  PluginContributionIdentityV1,
  PluginUiTranslationsContributionV1,
  HookRegistrationV1,
} from '@happier-dev/protocol';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';
import type {
    BackendRuntimeOwnerTakeoverMarker,
    CliRuntimeCoreGetter,
} from '@/agent/runtime/registry/engineRegistryTypes';

import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type ResolvedContributionProvenance = 'first_party' | 'external';

export type ResolvedContributionSourceKind = 'bundled' | 'path' | 'archive' | 'marketplace' | 'package';

export type ResolvedContributionSource = Readonly<{
    kind: ResolvedContributionSourceKind;
}>;

export type ResolvedAgentDefinitionContract = AgentDefinitionContractV1 & Readonly<
    Partial<Omit<AgentDefinitionV1, keyof AgentDefinitionContractV1>>
>;

export type ResolvedAgentRuntimeDefinitionContract = Omit<BackendDefinitionContractV1, 'providerId'> & Readonly<{
    agentId: string;
}>;

/**
 * Internal host projection shape.
 *
 * `catalogEntry` in merged contributes is intentionally internal-only in this
 * wave. It must not be treated as a stable external plugin ABI contract until
 * a narrower versioned contract replaces it.
 */
export type ResolvedCatalogEntry = Readonly<
    Omit<AgentCatalogEntry, 'id' | 'cliSubcommand'> & {
        id: string;
        cliSubcommand: string;
    }
>;

export type ResolvedAgentRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: AgentCatalogDefinition;
    }
    | {
        provenance: 'external';
        definition: AgentDefinitionV1;
    }
>;

export type ResolvedAgentRuntimeRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: BackendCatalogDefinition;
    }
    | {
        provenance: 'external';
        definition: Omit<BackendDefinitionV1, 'capabilities' | 'surfaceHandlers'> & Readonly<{
            capabilities: PluginBackendCapabilitiesV1;
            surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
        }>;
    }
>;

export type ResolvedAgentContribution = Readonly<{
    id: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: ResolvedAgentDefinitionContract;
    richDefinition?: ResolvedAgentRichDefinition;
    runtimeSpec?: ProviderCliRuntimeDescriptor | null;
    catalogEntry?: ResolvedCatalogEntry | null;
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>;

export type ResolvedAgentRuntimeContribution = Readonly<{
    id: string;
    agentId: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: ResolvedAgentRuntimeDefinitionContract;
    richDefinition?: ResolvedAgentRuntimeRichDefinition;
    runtimeKind?: string | null;
    capabilities?: PluginBackendCapabilitiesV1;
    surfaceHandlers?: readonly BackendSurfaceDeclarationV1[];
    getRuntimeCore?: CliRuntimeCoreGetter;
    runtimeOwner?: BackendRuntimeOwnerTakeoverMarker;
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>;

export type ResolvedActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ActionDefinitionV1;
}>;

export type ResolvedToolDefinition = Readonly<{
    kindVersion: 1;
    id: string;
    name: string;
    title: string;
    description?: string | null;
    safety: ActionDefinitionV1['safety'];
    surfaces: Readonly<Record<'cli' | 'mcp' | 'agent', boolean>>;
    inputSchema?: ActionDefinitionV1['inputSchema'];
    outputSchema?: ActionDefinitionV1['outputSchema'];
    inputHints?: ActionDefinitionV1['inputHints'];
    compatibility?: ActionDefinitionV1['compatibility'];
    examples?: ActionDefinitionV1['examples'];
    promptSnippet?: string | null;
    promptGuidelines?: readonly string[];
    actionId: string;
    execution?: ActionDefinitionV1['execution'];
}>;

export type ResolvedToolContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedToolDefinition;
}>;

export type ResolvedCommandVisibility = 'default' | 'advanced' | 'internal';

export type ResolvedCommandDefinition = Readonly<{
    kindVersion: 1;
    id: string;
    command: string;
    rootHelpLabel?: string;
    rootHelpDescription?: string;
    rootHelpDetail?: string;
    allowTmux: boolean;
    visibility?: ResolvedCommandVisibility;
    featureGate?: string;
    actionId: string;
}>;

export type ResolvedCommandContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedCommandDefinition;
}>;

export type ResolvedLifecycleHandlerEvent = 'activated' | 'deactivating' | 'deactivated';

export type ResolvedLifecycleHandlerDefinition = Readonly<{
    kindVersion: 1;
    id: string;
    event: ResolvedLifecycleHandlerEvent;
    priority: number;
}>;

export type ResolvedLifecycleHandlerContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedLifecycleHandlerDefinition;
}>;

export type ResolvedResourceDefinition = Readonly<{
    kindVersion: 1;
    id: string;
    type: string;
    title?: string | null;
    path?: string | null;
    digest?: string | null;
    contentType?: string | null;
}>;

export type ResolvedResourceContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedResourceDefinition;
}>;

export type ResolvedUiDescriptorField = Readonly<{
    id: string;
    kind: string;
    title: string;
    description?: string | null;
    order?: number;
    groupId?: string | null;
    featureGate?: string | null;
    actionId?: string | null;
    options?: readonly Readonly<{
        value: string;
        label: string;
    }>[];
}>;

export type ResolvedUiDescriptorDefinition = Readonly<{
    kindVersion: 1;
    id: string;
    surface: string;
    title: string;
    description?: string | null;
    order?: number;
    tone?: string | null;
    featureGate?: string | null;
    helpUrl?: string | null;
    fields: readonly ResolvedUiDescriptorField[];
}>;

export type ResolvedUiDescriptorContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedUiDescriptorDefinition;
}>;

export type ResolvedUiTranslationsContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginUiTranslationsContributionV1;
}>;

export type ResolvedStructuredMessageContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginStructuredMessageDescriptorV1;
}>;

export type ResolvedSessionHeaderActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginSessionHeaderActionDescriptorV1;
}>;

export type ResolvedSurfacePlacementContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginSurfacePlacementDescriptorV1;
}>;

export type ResolvedHostedWebContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    pluginRootPath?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginHostedWebContributionV1;
}>;

export type ResolvedEmbeddedWebBundleContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginEmbeddedWebBundleContributionV1;
}>;

export type ResolvedReactNativeBundleContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginReactNativeBundleContributionV1;
}>;

export type ResolvedUiArtifactContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    pluginRootPath?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginUiArtifactContributionV1;
}>;

export type ResolvedBrowserTargetContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginBrowserTargetContributionV1;
}>;

export type ResolvedBrowserActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginBrowserActionContributionV1;
}>;

export type ResolvedNotificationCategoryContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginNotificationCategoryContributionV2;
}>;

export type ResolvedNotificationChannelContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginNotificationChannelContributionV2;
}>;

export type ResolvedEventDefinition = Readonly<PluginEventContributionV1 & {
    id: string;
    localId: string;
}>;

export type ResolvedEventContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedEventDefinition;
}>;

export type ResolvedSettingsContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
  definition: PluginSettingsContributionV2;
}>;

export type ResolvedExecutionRunProfileContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginExecutionRunProfileContributionV2;
}>;

export type ResolvedMcpServerContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginMcpServerContributionV1;
}>;

export type ResolvedMcpDiscoveryProviderContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginMcpDiscoveryProviderContributionV1;
}>;

export type ResolvedInstallableContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: InstallableDependencyDescriptor;
}>;

export type ResolvedRequestInterceptorContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginRequestInterceptorContributionV1;
}>;

export type ResolvedScmHostingProviderContribution = Readonly<{
    id: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    identity?: PluginContributionIdentityV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ScmHostingProviderContribution;
}>;

export type ResolvedScmBackendContribution = Readonly<{
    id: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    identity?: PluginContributionIdentityV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ScmBackendContribution;
}>;

export type ResolvedConnectedAccountDescriptorContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginConnectedAccountDescriptorContributionV2;
}>;

export type ResolvedBackendSurfaceContribution = Readonly<{
    backendId: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    /**
     * Stable plugin-facing backend-surface descriptor plus host-local handler
     * metadata.
     */
    definition: BackendSurfaceDeclarationV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
}>;

export type ResolvedHookRegistration = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    definition: HookRegistrationV1;
}>;

export type ResolvedActivationTarget = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    activationEvents?: readonly string[];
}>;

export type ResolvedContributionInputs = Readonly<{
    agents?: readonly ResolvedAgentContribution[];
    agentRuntimes?: readonly ResolvedAgentRuntimeContribution[];
    catalogEntries?: readonly ResolvedCatalogEntry[];
    actions?: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources?: readonly ResolvedResourceContribution[];
    uiDescriptors?: readonly ResolvedUiDescriptorContribution[];
    uiTranslations?: readonly ResolvedUiTranslationsContribution[];
    structuredMessages?: readonly ResolvedStructuredMessageContribution[];
    sessionHeaderActions?: readonly ResolvedSessionHeaderActionContribution[];
    surfacePlacements?: readonly ResolvedSurfacePlacementContribution[];
    hostedWeb?: readonly ResolvedHostedWebContribution[];
    embeddedWebBundles?: readonly ResolvedEmbeddedWebBundleContribution[];
    reactNativeBundles?: readonly ResolvedReactNativeBundleContribution[];
    uiArtifacts?: readonly ResolvedUiArtifactContribution[];
    browserTargets?: readonly ResolvedBrowserTargetContribution[];
    browserActions?: readonly ResolvedBrowserActionContribution[];
    settings?: readonly ResolvedSettingsContribution[];
    notifications?: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels?: readonly ResolvedNotificationChannelContribution[];
    events?: readonly ResolvedEventContribution[];
    executionRunProfiles?: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers?: readonly ResolvedMcpServerContribution[];
    mcpDiscoveryProviders?: readonly ResolvedMcpDiscoveryProviderContribution[];
    managedDependencies?: readonly ResolvedInstallableContribution[];
    requestInterceptors?: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
    scmBackends?: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    activationTargets?: readonly ResolvedActivationTarget[];
    hookRegistrations?: readonly ResolvedHookRegistration[];
    lifecycleHandlers?: readonly ResolvedLifecycleHandlerContribution[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

export type ResolvedContributionRegistry = Readonly<{
    generationId?: string;
    agents: readonly ResolvedAgentContribution[];
    agentRuntimes: readonly ResolvedAgentRuntimeContribution[];
    actions: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources: readonly ResolvedResourceContribution[];
    uiDescriptors: readonly ResolvedUiDescriptorContribution[];
    uiTranslations?: readonly ResolvedUiTranslationsContribution[];
    structuredMessages?: readonly ResolvedStructuredMessageContribution[];
    sessionHeaderActions?: readonly ResolvedSessionHeaderActionContribution[];
    surfacePlacements?: readonly ResolvedSurfacePlacementContribution[];
    hostedWeb?: readonly ResolvedHostedWebContribution[];
    embeddedWebBundles?: readonly ResolvedEmbeddedWebBundleContribution[];
    reactNativeBundles?: readonly ResolvedReactNativeBundleContribution[];
    uiArtifacts?: readonly ResolvedUiArtifactContribution[];
    browserTargets?: readonly ResolvedBrowserTargetContribution[];
    browserActions?: readonly ResolvedBrowserActionContribution[];
    settings?: readonly ResolvedSettingsContribution[];
    notifications?: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels?: readonly ResolvedNotificationChannelContribution[];
    events?: readonly ResolvedEventContribution[];
    executionRunProfiles?: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers?: readonly ResolvedMcpServerContribution[];
    mcpDiscoveryProviders?: readonly ResolvedMcpDiscoveryProviderContribution[];
    managedDependencies?: readonly ResolvedInstallableContribution[];
    requestInterceptors?: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
    scmBackends?: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    activationTargets: readonly ResolvedActivationTarget[];
    hookRegistrations: readonly ResolvedHookRegistration[];
    lifecycleHandlers?: readonly ResolvedLifecycleHandlerContribution[];
    actionsById?: ReadonlyMap<string, ResolvedActionContribution>;
    toolsById?: ReadonlyMap<string, ResolvedToolContribution>;
    commandsById?: ReadonlyMap<string, ResolvedCommandContribution>;
    resourcesById?: ReadonlyMap<string, ResolvedResourceContribution>;
    uiDescriptorsById?: ReadonlyMap<string, ResolvedUiDescriptorContribution>;
    structuredMessagesById?: ReadonlyMap<string, ResolvedStructuredMessageContribution>;
    sessionHeaderActionsById?: ReadonlyMap<string, ResolvedSessionHeaderActionContribution>;
    surfacePlacementsById?: ReadonlyMap<string, ResolvedSurfacePlacementContribution>;
    hostedWebById?: ReadonlyMap<string, ResolvedHostedWebContribution>;
    embeddedWebBundlesById?: ReadonlyMap<string, ResolvedEmbeddedWebBundleContribution>;
    reactNativeBundlesById?: ReadonlyMap<string, ResolvedReactNativeBundleContribution>;
    uiArtifactsById?: ReadonlyMap<string, ResolvedUiArtifactContribution>;
    browserTargetsById?: ReadonlyMap<string, ResolvedBrowserTargetContribution>;
    browserActionsById?: ReadonlyMap<string, ResolvedBrowserActionContribution>;
    settingsById?: ReadonlyMap<string, ResolvedSettingsContribution>;
    notificationsById?: ReadonlyMap<string, ResolvedNotificationCategoryContribution>;
    notificationChannelsById?: ReadonlyMap<string, ResolvedNotificationChannelContribution>;
    eventsById?: ReadonlyMap<string, ResolvedEventContribution>;
    executionRunProfilesById?: ReadonlyMap<string, ResolvedExecutionRunProfileContribution>;
    managedDependenciesByKey?: ReadonlyMap<string, ResolvedInstallableContribution>;
    scmHostingProvidersById?: ReadonlyMap<string, ResolvedScmHostingProviderContribution>;
    scmBackendsById?: ReadonlyMap<string, ResolvedScmBackendContribution>;
    connectedAccountDescriptorsById?: ReadonlyMap<string, ResolvedConnectedAccountDescriptorContribution>;
    lifecycleHandlersById?: ReadonlyMap<string, ResolvedLifecycleHandlerContribution>;
    surfaceHandlersByBackendId: ReadonlyMap<string, readonly ResolvedBackendSurfaceContribution[]>;
    catalogEntriesById: Readonly<Record<string, ResolvedCatalogEntry>>;
    agentDefinitionsById: ReadonlyMap<string, ResolvedAgentContribution>;
    agentRuntimeDefinitionsById: ReadonlyMap<string, ResolvedAgentRuntimeContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
