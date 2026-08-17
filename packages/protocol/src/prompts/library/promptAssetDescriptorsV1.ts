import { z } from 'zod';

export const PromptAssetScopeV1Schema = z.enum(['user', 'project']);
export type PromptAssetScopeV1 = z.infer<typeof PromptAssetScopeV1Schema>;

export const PromptAssetLibraryKindV1Schema = z.enum(['doc', 'bundle']);
export type PromptAssetLibraryKindV1 = z.infer<typeof PromptAssetLibraryKindV1Schema>;

export const PromptAssetInstallModeV1Schema = z.enum(['copy', 'symlink']);
export type PromptAssetInstallModeV1 = z.infer<typeof PromptAssetInstallModeV1Schema>;

export const PromptAssetSupportsScopeV1Schema = z
  .object({
    user: z.boolean(),
    project: z.boolean(),
  })
  .passthrough();
export type PromptAssetSupportsScopeV1 = z.infer<typeof PromptAssetSupportsScopeV1Schema>;

export const PromptAssetCapabilitiesV1Schema = z
  .object({
    supportsCatalogInstall: z.boolean().optional(),
    supportsNestedNamespaces: z.boolean().optional(),
    supportsSymlinkInstall: z.boolean().optional(),
  })
  .passthrough()
  .default({});
export type PromptAssetCapabilitiesV1 = z.infer<typeof PromptAssetCapabilitiesV1Schema>;
export type PromptAssetCapabilities = z.infer<typeof PromptAssetCapabilitiesV1Schema>;

export const PromptAssetDefaultRootV1Schema = z
  .object({
    label: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    pathTemplate: z.string().min(1),
  })
  .passthrough();
export type PromptAssetDefaultRootV1 = z.infer<typeof PromptAssetDefaultRootV1Schema>;

export const PromptAssetTypeDescriptorV1Schema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    libraryKind: PromptAssetLibraryKindV1Schema,
    supportsScope: PromptAssetSupportsScopeV1Schema,
    supportsFiles: z.boolean(),
    formatId: z.string().min(1),
    defaultRoots: z.array(PromptAssetDefaultRootV1Schema),
    capabilities: PromptAssetCapabilitiesV1Schema,
  })
  .passthrough();
export type PromptAssetTypeDescriptorV1 = z.infer<typeof PromptAssetTypeDescriptorV1Schema>;
export type PromptAssetTypeDescriptor = z.infer<typeof PromptAssetTypeDescriptorV1Schema>;
