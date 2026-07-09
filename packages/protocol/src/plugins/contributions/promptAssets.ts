import { z } from 'zod';

import { PromptAssetCapabilitiesV1Schema } from '../../prompts/library/promptAssetsV1.js';

export const PluginPromptAssetAdapterKindV1Schema = z.enum(['skillMd', 'markdownDoc']);
export type PluginPromptAssetAdapterKindV1 = z.infer<typeof PluginPromptAssetAdapterKindV1Schema>;

const PluginPromptAssetPathSegmentsV1Schema = z.array(z.string().trim().min(1)).min(1);

export const PluginPromptAssetContributionV1Schema = z.object({
  adapterKind: PluginPromptAssetAdapterKindV1Schema,
  assetTypeId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  projectRootPath: PluginPromptAssetPathSegmentsV1Schema,
  projectRootDisplayPath: z.string().trim().min(1),
  userRootPath: PluginPromptAssetPathSegmentsV1Schema,
  userRootDisplayPath: z.string().trim().min(1),
  capabilities: PromptAssetCapabilitiesV1Schema.optional(),
}).strict();
export type PluginPromptAssetContributionV1 = z.infer<typeof PluginPromptAssetContributionV1Schema>;
