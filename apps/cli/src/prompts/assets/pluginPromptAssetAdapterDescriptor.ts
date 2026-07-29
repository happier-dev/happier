import type { PromptAssetCapabilitiesV1 } from '@happier-dev/protocol';

type PluginPromptAssetAdapterDescriptorBase = Readonly<{
  assetTypeId: string;
  providerId: string;
  title: string;
  description: string;
  projectRootPath: readonly string[];
  projectRootDisplayPath: string;
  userRootPath: readonly string[];
  userRootDisplayPath: string;
  capabilities?: PromptAssetCapabilitiesV1;
}>;

export type PluginPromptAssetAdapterDescriptor = PluginPromptAssetAdapterDescriptorBase & Readonly<{
  adapterKind: 'markdownDoc' | 'skillMd';
  skillNamePattern?: RegExp;
}>;
