import type {
  BackendDefinitionV1,
  ExtensionActionContributionV2,
  ExtensionCommandContributionV2,
  ExtensionHookContributionV2,
  ExtensionLifecycleHandlerContributionV2,
  ExtensionManifestMarketplaceMetadataV1,
  ExtensionPermissionDeclarationV1,
  ExtensionRuntimeApiV1,
  ExtensionSourceSpecV1,
  ExtensionToolContributionV2,
  ExtensionUiDescriptorContributionV2,
  ExtensionResourceContributionV2,
  ProviderDefinitionV1,
} from '@happier-dev/protocol';

export type CanonicalPluginManifestContributions = Readonly<{
  providers: readonly ProviderDefinitionV1[];
  backends: readonly BackendDefinitionV1[];
  actions: readonly ExtensionActionContributionV2[];
  tools: readonly ExtensionToolContributionV2[];
  commands: readonly ExtensionCommandContributionV2[];
  resources: readonly ExtensionResourceContributionV2[];
  uiDescriptors: readonly ExtensionUiDescriptorContributionV2[];
  hooks: readonly ExtensionHookContributionV2[];
  lifecycleHandlers: readonly ExtensionLifecycleHandlerContributionV2[];
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
    apiVersion: ExtensionRuntimeApiV1['apiVersion'];
    capabilities: readonly ExtensionRuntimeApiV1['capabilities'][number][];
  }>;
  targets: Readonly<{
    daemon?: Readonly<{
      entry: string;
    }>;
  }>;
  permissions: readonly ExtensionPermissionDeclarationV1[];
  source?: ExtensionSourceSpecV1;
  marketplace?: ExtensionManifestMarketplaceMetadataV1;
  contributions: CanonicalPluginManifestContributions;
}>;
