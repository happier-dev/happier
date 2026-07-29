import type {
    BackendCatalogDefinition,
    BackendDefinitionContractV1,
    AgentDefinitionContractV1,
} from '@happier-dev/agents';
import type {
  ActionDefinitionV1,
  HookCategoryV1,
  HookExecutionKindV1,
  HookScopeV1,
  AgentDefinitionV1,
  PluginAgentContributionV2,
  PluginActionContributionV2,
  PluginBackendDefinitionV1,
  BackendSurfaceDeclarationV1,
  PluginBackendCapabilitiesV1,
  PluginBrowserActionContributionV1,
  PluginBrowserTargetContributionV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginPromptAssetContributionV1,
  PluginExecutionRunProfileContributionV2,
  PluginHostedWebContributionV1,
  PluginReactNativeBundleContributionV1,
  PluginSessionHeaderActionDescriptorV1,
  PluginSurfacePlacementDescriptorV1,
  PluginMcpDiscoveryProviderContributionV1,
  PluginMcpServerContributionV1,
  PluginRequestInterceptorContributionV1,
  InstallableDependencyDescriptor,
  PluginManagedDependencyContributionV2,
  ScmBackendContribution,
  PluginSettingsContributionV2,
  PluginStructuredMessageDescriptorV1,
  PluginSystemToolContributionV1,
  PluginUiArtifactContributionV1,
  ScmHostingProviderContribution,
  PluginConnectedAccountDescriptorContributionV2,
  PluginEventContributionV1,
  PluginSourceSpecV1,
  PluginContributionIdentityV1,
  PluginToolContributionV2,
  PluginCommandContributionV2,
  ProviderContributionV1,
  PluginAgentCliMetadata,
  PluginUiTranslationsContributionV1,
  PluginUiRendererV2,
  PluginUiViewV2,
  PluginUiTranslationBundleV2,
  VoiceModelPackContributionV1,
  PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import type { PluginUiArtifactsManifestV1 } from '@happier-dev/protocol/plugins/ui';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginContributionIntrospectionCandidate } from '@/plugins/projection/introspection/types';
import type {
  ManagedProviderRuntimeAdapterV1,
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';

export type ResolvedContributionProvenance = 'first_party' | 'external';

export type ResolvedContributionSourceKind = 'bundled' | 'path' | 'archive' | 'marketplace' | 'package';

export type ResolvedContributionSource = Readonly<{
    kind: ResolvedContributionSourceKind;
}>;

export type PluginLocaleScopedIdentity = Readonly<{
    pluginId: string;
    locale: string;
}>;

export type ResolvedTargetUiContribution<T> = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    pluginVersion?: string;
    identity: PluginContributionIdentityV1;
    manifestPath: string;
    manifestDigest: string;
    definition: T;
}>;
export type ResolvedUiViewV2Contribution = ResolvedTargetUiContribution<PluginUiViewV2>;
export type ResolvedUiRendererV2Contribution = ResolvedTargetUiContribution<PluginUiRendererV2> & Readonly<{
    pluginRootPath?: string;
    generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
}>;
export type ResolvedUiTranslationBundleV2Contribution = Readonly<
    Omit<ResolvedTargetUiContribution<PluginUiTranslationBundleV2>, 'identity'> & {
        localeIdentity: PluginLocaleScopedIdentity;
    }
>;
export type ResolvedVoiceModelPackContribution = ResolvedTargetUiContribution<VoiceModelPackContributionV1> & Readonly<{
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
}>;
export type ResolvedVoiceProviderContribution = ResolvedTargetUiContribution<PluginVoiceProviderContributionV1> & Readonly<{
    pluginRootPath?: string;
    sourceSpec?: PluginSourceSpecV1;
    generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
}>;

export type ResolvedAgentDefinitionContract = AgentDefinitionContractV1 & Readonly<
    Partial<Omit<AgentDefinitionV1, keyof AgentDefinitionContractV1>>
>;

export type ResolvedAgentRuntimeDefinitionContract = BackendDefinitionContractV1;

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
        definition: PluginAgentContributionV2;
    }
    | {
        provenance: 'external';
        definition: PluginAgentContributionV2;
    }
>;

export type ResolvedAgentRuntimeRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: BackendCatalogDefinition;
    }
    | {
        provenance: 'external';
        definition: Omit<PluginBackendDefinitionV1, 'capabilities' | 'surfaceHandlers'> & Readonly<{
            capabilities: PluginBackendCapabilitiesV1;
            surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
        }>;
    }
>;

export type ResolvedAgentContribution = Readonly<{
    id: string;
    /** Stable manifest-qualified identity. This is intentionally independent of runtime generation. */
    identity?: PluginContributionIdentityV1;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: ResolvedAgentDefinitionContract;
    richDefinition?: ResolvedAgentRichDefinition;
    runtimeSpec?: AgentCliRuntimeDescriptor | null;
    /** Strict native manifest metadata retained for host-owned auth/login projections. */
    cliMetadata?: PluginAgentCliMetadata | null;
    catalogEntry?: ResolvedCatalogEntry | null;
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    /** Cold-manifest package access declarations used by Agent operation services.
     * This remains independent of executable activation-target projection. */
    hostAccess?: CanonicalPluginManifest['hostAccess'];
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
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>;

type ResolvedProviderContributionBase = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    identity: PluginContributionIdentityV1;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ProviderContributionV1;
}>;

export type ResolvedProviderContribution = ResolvedProviderContributionBase & Readonly<
    | {
        provenance: 'first_party';
        managed?: ResolvedFirstPartyManagedProviderFacet;
        managedRuntimeAdapter?: ManagedProviderRuntimeAdapterV1;
    }
    | {
        provenance: 'external';
        managed?: never;
        managedRuntimeAdapter?: never;
    }
>;

export type ResolvedActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedActionDefinition;
}>;

/** Canonical V2 action truth retained alongside the legacy ActionSpec shell. */
export type ResolvedActionDefinition = Readonly<
    ActionDefinitionV1 & (
        | Readonly<{
            dangerLevel: 'safe';
            confirmation?: never;
        }>
        | Readonly<{
            dangerLevel: Exclude<PluginActionContributionV2['dangerLevel'], 'safe'>;
            confirmation: NonNullable<PluginActionContributionV2['confirmation']>;
        }>
    )
>;

export type ResolvedToolDefinition = Readonly<PluginToolContributionV2 & {
    kindVersion: 1;
    actionId: string;
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

export type ResolvedCommandDefinition = Readonly<PluginCommandContributionV2 & {
    kindVersion: 1;
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
    pluginRootPath?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedResourceDefinition;
}>;

export type ResolvedPromptAssetContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    identity: PluginContributionIdentityV1;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    definition: PluginPromptAssetContributionV1;
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
    definition: InstallableDependencyDescriptor | PluginManagedDependencyContributionV2;
}>;

export type ResolvedSystemToolContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginSystemToolContributionV1;
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

export type ResolvedActivatedHookRegistration = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    definition: Readonly<{
        hookApiVersion: 1;
        id: string;
        eventId?: string;
        category: HookCategoryV1;
        scope: HookScopeV1;
        filters?: Readonly<{
            agentId?: string;
            runtimeTargetId?: string;
            sessionId?: string;
            workspaceId?: string;
            cwdPrefix?: string;
            machineId?: string;
            eventNames?: readonly string[];
            [key: string]: unknown;
        }>;
        executionKind: HookExecutionKindV1;
        aggregation?: string;
        failureMode?: string;
        priority?: number;
        compatibility?: Readonly<Record<string, unknown>>;
        metadata?: Readonly<Record<string, unknown>>;
    }>;
}>;

export type ResolvedActivationTarget = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    activationEvents?: readonly string[];
    manifest: CanonicalPluginManifest;
}>;

export type ResolvedContributionInputs = Readonly<{
    introspectionContributions?: readonly PluginContributionIntrospectionCandidate[];
    uiViewsV2?: readonly ResolvedUiViewV2Contribution[];
    uiRenderersV2?: readonly ResolvedUiRendererV2Contribution[];
    uiTranslationsV2?: readonly ResolvedUiTranslationBundleV2Contribution[];
    agents?: readonly ResolvedAgentContribution[];
    providers?: readonly ResolvedProviderContribution[];
    catalogEntries?: readonly ResolvedCatalogEntry[];
    actions?: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources?: readonly ResolvedResourceContribution[];
    promptAssets?: readonly ResolvedPromptAssetContribution[];
    uiTranslations?: readonly ResolvedUiTranslationsContribution[];
    structuredMessages?: readonly ResolvedStructuredMessageContribution[];
    sessionHeaderActions?: readonly ResolvedSessionHeaderActionContribution[];
    surfacePlacements?: readonly ResolvedSurfacePlacementContribution[];
    hostedWeb?: readonly ResolvedHostedWebContribution[];
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
    systemTools?: readonly ResolvedSystemToolContribution[];
    requestInterceptors?: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
    scmBackends?: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    voiceModelPacks?: readonly ResolvedVoiceModelPackContribution[];
    voiceProviders?: readonly ResolvedVoiceProviderContribution[];
    activationTargets?: readonly ResolvedActivationTarget[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

export type ResolvedContributionRegistry = Readonly<{
    introspectionContributions?: readonly PluginContributionIntrospectionCandidate[];
    uiViewsV2?: readonly ResolvedUiViewV2Contribution[];
    uiRenderersV2?: readonly ResolvedUiRendererV2Contribution[];
    uiTranslationsV2?: readonly ResolvedUiTranslationBundleV2Contribution[];
    generationId?: string;
    agents: readonly ResolvedAgentContribution[];
    providers?: readonly ResolvedProviderContribution[];
    actions: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources: readonly ResolvedResourceContribution[];
    promptAssets?: readonly ResolvedPromptAssetContribution[];
    uiTranslations?: readonly ResolvedUiTranslationsContribution[];
    structuredMessages?: readonly ResolvedStructuredMessageContribution[];
    sessionHeaderActions?: readonly ResolvedSessionHeaderActionContribution[];
    surfacePlacements?: readonly ResolvedSurfacePlacementContribution[];
    hostedWeb?: readonly ResolvedHostedWebContribution[];
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
    systemTools?: readonly ResolvedSystemToolContribution[];
    requestInterceptors?: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
    scmBackends?: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    voiceModelPacks?: readonly ResolvedVoiceModelPackContribution[];
    voiceProviders?: readonly ResolvedVoiceProviderContribution[];
    activationTargets: readonly ResolvedActivationTarget[];
    actionsById?: ReadonlyMap<string, ResolvedActionContribution>;
    toolsById?: ReadonlyMap<string, ResolvedToolContribution>;
    commandsById?: ReadonlyMap<string, ResolvedCommandContribution>;
    resourcesById?: ReadonlyMap<string, ResolvedResourceContribution>;
    promptAssetsById?: ReadonlyMap<string, ResolvedPromptAssetContribution>;
    structuredMessagesById?: ReadonlyMap<string, ResolvedStructuredMessageContribution>;
    sessionHeaderActionsById?: ReadonlyMap<string, ResolvedSessionHeaderActionContribution>;
    surfacePlacementsById?: ReadonlyMap<string, ResolvedSurfacePlacementContribution>;
    hostedWebById?: ReadonlyMap<string, ResolvedHostedWebContribution>;
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
    systemToolsById?: ReadonlyMap<string, ResolvedSystemToolContribution>;
    scmHostingProvidersById?: ReadonlyMap<string, ResolvedScmHostingProviderContribution>;
    scmBackendsById?: ReadonlyMap<string, ResolvedScmBackendContribution>;
    connectedAccountDescriptorsById?: ReadonlyMap<string, ResolvedConnectedAccountDescriptorContribution>;
    catalogEntriesById: Readonly<Record<string, ResolvedCatalogEntry>>;
    agentDefinitionsById: ReadonlyMap<string, ResolvedAgentContribution>;
    providersByContributionKey?: ReadonlyMap<string, ResolvedProviderContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;
