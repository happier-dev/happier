import type {
  BackendDefinitionV1,
  BackendSurfaceDeclarationV1,
  PluginBackendCapabilitiesV1,
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
  PluginRuntimeApiV1,
  InstallableDependencyDescriptor,
  ScmBackendContribution,
  ScmHostingProviderContribution,
  PluginSystemToolContributionV1,
  PluginSourceSpecV1,
  PluginToolContributionV2,
  PluginUiDescriptorContributionV2,
  PluginResourceContributionV2,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';

export type CanonicalPluginBackendDefinition = Omit<BackendDefinitionV1, 'capabilities'> & Readonly<{
  capabilities: PluginBackendCapabilitiesV1;
  surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
}>;

export type CanonicalPluginManifestContributes = Readonly<{
  providers: readonly ProviderDefinitionV1[];
  backends: readonly CanonicalPluginBackendDefinition[];
  actions: readonly PluginActionContributionV2[];
  tools: readonly PluginToolContributionV2[];
  commands: readonly PluginCommandContributionV2[];
  resources: readonly PluginResourceContributionV2[];
  uiDescriptors: readonly PluginUiDescriptorContributionV2[];
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
  installables?: readonly InstallableDependencyDescriptor[];
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
  runtime: Readonly<{
    apiVersion: PluginRuntimeApiV1['apiVersion'];
    capabilities: readonly PluginRuntimeApiV1['capabilities'][number][];
  }>;
  targets: Readonly<{
    daemon?: Readonly<{
      entry: string;
    }>;
  }>;
  permissions: readonly PluginPermissionDeclarationV1[];
  optionalPermissions?: readonly PluginPermissionDeclarationV1[];
  source?: PluginSourceSpecV1;
  marketplace?: PluginManifestMarketplaceMetadataV1;
  contributes: CanonicalPluginManifestContributes;
}>;
