import type {
  PromptAssetDeleteRequest,
  PromptAssetDiscoverRequest,
  PromptAssetDiscoveryItemV1,
  PromptAssetMutationResponseV1,
  PromptAssetReadRequest,
  PromptAssetReadResponseV1,
  PromptAssetTypeDescriptorV1,
  PromptAssetWriteDocRequest,
  PromptAssetWriteBundleRequest,
} from '@happier-dev/protocol';

export type PromptAssetAdapter = Readonly<{
  descriptor: PromptAssetTypeDescriptorV1;
  discover: (request: PromptAssetDiscoverRequest) => Promise<PromptAssetDiscoveryItemV1[]>;
  read: (request: PromptAssetReadRequest) => Promise<PromptAssetReadResponseV1>;
  writeDoc: (request: PromptAssetWriteDocRequest) => Promise<PromptAssetMutationResponseV1>;
  writeBundle: (request: PromptAssetWriteBundleRequest) => Promise<PromptAssetMutationResponseV1>;
  delete: (request: PromptAssetDeleteRequest) => Promise<PromptAssetMutationResponseV1>;
}>;
