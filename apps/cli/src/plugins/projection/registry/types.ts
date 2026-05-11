import type {
    BackendCatalogDefinition,
    ProviderCatalogDefinition,
    BackendDefinitionContractV1,
    ProviderDefinitionContractV1,
} from '@happier-dev/agents';
import type {
  ActionDefinitionV1,
  BackendDefinitionV1,
  BackendRuntimeAdapterV1,
  PluginBackendCapabilitiesV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginExecutionRunProfileContributionV2,
  PluginMcpDiscoveryProviderContributionV1,
  PluginMcpServerContributionV1,
  InstallableDependencyDescriptor,
  ScmBackendContribution,
  PluginSettingsContributionV2,
  ScmHostingProviderContribution,
  PluginConnectedAccountDescriptorContributionV2,
  PluginSourceSpecV1,
  PluginContributionIdentityV1,
  HookRegistrationV1,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';
import type { CliRuntimeCoreGetter } from '@/agent/runtime/registry/engineRegistryTypes';

import type { AgentCatalogEntry } from '@/backends/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type ResolvedContributionProvenance = 'first_party' | 'external';

export type ResolvedContributionSourceKind = 'bundled' | 'path' | 'archive' | 'marketplace' | 'package';

export type ResolvedContributionSource = Readonly<{
    kind: ResolvedContributionSourceKind;
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

export type ResolvedProviderRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: ProviderCatalogDefinition;
    }
    | {
        provenance: 'external';
        definition: ProviderDefinitionV1;
    }
>;

export type ResolvedBackendRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: BackendCatalogDefinition;
    }
    | {
        provenance: 'external';
        definition: BackendDefinitionV1;
    }
>;

export type ResolvedProviderContribution = Readonly<{
    id: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: ProviderDefinitionContractV1;
    richDefinition?: ResolvedProviderRichDefinition;
    runtimeSpec?: ProviderCliRuntimeDescriptor | null;
    catalogEntry?: ResolvedCatalogEntry | null;
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
}>;

export type ResolvedBackendContribution = Readonly<{
    id: string;
    providerId: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: BackendDefinitionContractV1;
    richDefinition?: ResolvedBackendRichDefinition;
    runtimeKind?: string | null;
    capabilities?: PluginBackendCapabilitiesV1;
    runtimeCoreHooks?: readonly BackendRuntimeAdapterV1[];
    getRuntimeCore?: CliRuntimeCoreGetter;
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
}>;

export type ResolvedActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
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
    surfaces: Readonly<Record<'cli' | 'mcp' | 'session_agent', boolean>>;
    inputSchema?: ActionDefinitionV1['inputSchema'];
    outputSchema?: ActionDefinitionV1['outputSchema'];
    inputHints?: ActionDefinitionV1['inputHints'];
    compatibility?: ActionDefinitionV1['compatibility'];
    examples?: ActionDefinitionV1['examples'];
    actionId: string;
}>;

export type ResolvedToolContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
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
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedCommandDefinition;
}>;

export type ResolvedLifecycleHandlerEvent = 'activated' | 'deactivating';

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
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedUiDescriptorDefinition;
}>;

export type ResolvedNotificationCategoryContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
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
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginNotificationChannelContributionV2;
}>;

export type ResolvedSettingsContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
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
    sourceSpec?: PluginSourceSpecV1;
    definition: InstallableDependencyDescriptor;
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
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginConnectedAccountDescriptorContributionV2;
}>;

export type ResolvedBackendRuntimeAdapterContribution = Readonly<{
    backendId: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    /**
     * Stable plugin-facing runtime-adapter descriptor plus host-local handler
     * metadata.
     */
    definition: BackendRuntimeAdapterV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
}>;

export type ResolvedHookRegistration = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
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
    sourceSpec: PluginSourceSpecV1;
}>;

export type ResolvedContributionInputs = Readonly<{
    providers: readonly ResolvedProviderContribution[];
    backends: readonly ResolvedBackendContribution[];
    catalogEntries?: readonly ResolvedCatalogEntry[];
    actions?: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources?: readonly ResolvedResourceContribution[];
    uiDescriptors?: readonly ResolvedUiDescriptorContribution[];
    settings?: readonly ResolvedSettingsContribution[];
    notifications?: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels?: readonly ResolvedNotificationChannelContribution[];
    executionRunProfiles?: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers?: readonly ResolvedMcpServerContribution[];
    mcpDiscoveryProviders?: readonly ResolvedMcpDiscoveryProviderContribution[];
    installables?: readonly ResolvedInstallableContribution[];
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
    providers: readonly ResolvedProviderContribution[];
    backends: readonly ResolvedBackendContribution[];
    actions: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources: readonly ResolvedResourceContribution[];
    uiDescriptors: readonly ResolvedUiDescriptorContribution[];
    settings?: readonly ResolvedSettingsContribution[];
    notifications?: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels?: readonly ResolvedNotificationChannelContribution[];
    executionRunProfiles?: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers?: readonly ResolvedMcpServerContribution[];
    mcpDiscoveryProviders?: readonly ResolvedMcpDiscoveryProviderContribution[];
    installables?: readonly ResolvedInstallableContribution[];
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
    settingsById?: ReadonlyMap<string, ResolvedSettingsContribution>;
    notificationsById?: ReadonlyMap<string, ResolvedNotificationCategoryContribution>;
    notificationChannelsById?: ReadonlyMap<string, ResolvedNotificationChannelContribution>;
    executionRunProfilesById?: ReadonlyMap<string, ResolvedExecutionRunProfileContribution>;
    installablesByKey?: ReadonlyMap<string, ResolvedInstallableContribution>;
    scmHostingProvidersById?: ReadonlyMap<string, ResolvedScmHostingProviderContribution>;
    scmBackendsById?: ReadonlyMap<string, ResolvedScmBackendContribution>;
    connectedAccountDescriptorsById?: ReadonlyMap<string, ResolvedConnectedAccountDescriptorContribution>;
    lifecycleHandlersById?: ReadonlyMap<string, ResolvedLifecycleHandlerContribution>;
    runtimeCoreHooksByBackendId: ReadonlyMap<string, readonly ResolvedBackendRuntimeAdapterContribution[]>;
    catalogEntriesById: Readonly<Record<string, ResolvedCatalogEntry>>;
    providerDefinitionsById: ReadonlyMap<string, ResolvedProviderContribution>;
    backendDefinitionsById: ReadonlyMap<string, ResolvedBackendContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
