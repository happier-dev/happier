import type {
  BackendDefinitionV1,
  AgentDefinitionV1,
  BackendSurfaceDeclarationV1,
  PluginBackendCapabilitiesV1,
  PluginRuntimeCapabilityFamilyV1,
  PluginAgentSettingsContributionV1,
  PluginActionContributionV2,
  PluginCommandContributionV2,
  PluginExecutionRunProfileContributionV2,
  PluginEventContributionV1,
  PluginHookContributionV2,
  PluginLifecycleHandlerContributionV2,
  PluginManifestMarketplaceMetadataV1,
  PluginMcpContributesV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginPermissionDeclarationV1,
  PluginRequestInterceptorContributionV1,
  InstallableDependencyDescriptor,
  ScmBackendContribution,
  ScmHostingProviderContribution,
  PluginBrowserActionContributionV1,
  PluginBrowserTargetContributionV1,
  PluginSystemToolContributionV1,
  PluginSourceSpecV1,
  PluginToolContributionV2,
  PluginHostedWebContributionV1,
  PluginEmbeddedWebBundleContributionV1,
  PluginReactNativeBundleContributionV1,
  PluginSessionHeaderActionDescriptorV1,
  PluginSettingsContributionV2,
  PluginSurfacePlacementDescriptorV1,
  PluginStructuredMessageDescriptorV1,
  PluginUiArtifactContributionV1,
  PluginUiDescriptorContributionV2,
  PluginUiTranslationsContributionV1,
  PluginResourceContributionV2,
} from '@happier-dev/protocol';

export type CanonicalPluginAgentRuntimeDefinition = Omit<BackendDefinitionV1, 'capabilities' | 'providerId'> & Readonly<{
  agentId: string;
  capabilities: PluginBackendCapabilitiesV1;
  surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
}>;

export type CanonicalPluginManifestContributes = Readonly<{
  agents: readonly AgentDefinitionV1[];
  agentRuntimes: readonly CanonicalPluginAgentRuntimeDefinition[];
  actions: readonly PluginActionContributionV2[];
  tools: readonly PluginToolContributionV2[];
  commands: readonly PluginCommandContributionV2[];
  resources: readonly PluginResourceContributionV2[];
  uiDescriptors: readonly PluginUiDescriptorContributionV2[];
  uiTranslations?: readonly PluginUiTranslationsContributionV1[];
  structuredMessages?: readonly PluginStructuredMessageDescriptorV1[];
  sessionHeaderActions?: readonly PluginSessionHeaderActionDescriptorV1[];
  surfacePlacements?: readonly PluginSurfacePlacementDescriptorV1[];
  hostedWeb?: readonly PluginHostedWebContributionV1[];
  embeddedWebBundles?: readonly PluginEmbeddedWebBundleContributionV1[];
  reactNativeBundles?: readonly PluginReactNativeBundleContributionV1[];
  uiArtifacts?: readonly PluginUiArtifactContributionV1[];
  browserTargets?: readonly PluginBrowserTargetContributionV1[];
  browserActions?: readonly PluginBrowserActionContributionV1[];
  settings?: readonly PluginSettingsContributionV2[];
  notifications?: readonly PluginNotificationCategoryContributionV2[];
  notificationChannels?: readonly PluginNotificationChannelContributionV2[];
  events?: readonly PluginEventContributionV1[];
  executionRunProfiles?: readonly PluginExecutionRunProfileContributionV2[];
  mcp?: Readonly<{
    servers: ReadonlyArray<PluginMcpContributesV1['servers'][number]>;
    discoveryProviders: ReadonlyArray<PluginMcpContributesV1['discoveryProviders'][number]>;
  }>;
  scmHostingProviders?: readonly ScmHostingProviderContribution[];
  scmBackends?: readonly ScmBackendContribution[];
  managedDependencies?: readonly InstallableDependencyDescriptor[];
  agentSettings?: readonly PluginAgentSettingsContributionV1[];
  systemTools?: readonly PluginSystemToolContributionV1[];
  requestInterceptors?: readonly PluginRequestInterceptorContributionV1[];
  hooks: readonly PluginHookContributionV2[];
  lifecycleHandlers: readonly PluginLifecycleHandlerContributionV2[];
}>;

export type CanonicalPluginManifest = Readonly<{
  schemaVersion: 2;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  engines: Readonly<{
    happier: string;
  }>;
  activationEvents: readonly string[];
  uses: readonly PluginRuntimeCapabilityFamilyV1[];
  entrypoints: Readonly<{
    main: string;
    dev?: string;
  }>;
  permissions: readonly PluginPermissionDeclarationV1[];
  optionalPermissions?: readonly PluginPermissionDeclarationV1[];
  source?: PluginSourceSpecV1;
  marketplace?: PluginManifestMarketplaceMetadataV1;
  contributes: CanonicalPluginManifestContributes;
}>;
