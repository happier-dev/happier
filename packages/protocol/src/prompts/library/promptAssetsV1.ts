import { z } from 'zod';

import {
  PromptBundleBodyV1Schema,
  PromptBundleSchemaIdV1Schema,
} from './promptBundleSchemas.js';
import {
  PromptAssetInstallModeV1Schema,
  PromptAssetLibraryKindV1Schema,
  PromptAssetScopeV1Schema,
  PromptAssetTypeDescriptorV1Schema,
} from './promptAssetDescriptorsV1.js';

export {
  PromptAssetCapabilitiesV1Schema,
  PromptAssetDefaultRootV1Schema,
  PromptAssetInstallModeV1Schema,
  PromptAssetLibraryKindV1Schema,
  PromptAssetScopeV1Schema,
  PromptAssetSupportsScopeV1Schema,
  PromptAssetTypeDescriptorV1Schema,
  type PromptAssetCapabilities,
  type PromptAssetCapabilitiesV1,
  type PromptAssetDefaultRootV1,
  type PromptAssetInstallModeV1,
  type PromptAssetLibraryKindV1,
  type PromptAssetScopeV1,
  type PromptAssetSupportsScopeV1,
  type PromptAssetTypeDescriptor,
  type PromptAssetTypeDescriptorV1,
} from './promptAssetDescriptorsV1.js';

export const PromptAssetExternalRefV1Schema = z.record(z.string(), z.unknown());
export type PromptAssetExternalRefV1 = z.infer<typeof PromptAssetExternalRefV1Schema>;

export const PromptAssetDiscoveryItemV1Schema = z
  .object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    externalRef: PromptAssetExternalRefV1Schema,
    title: z.string().min(1),
    libraryKind: PromptAssetLibraryKindV1Schema,
    bundleSchemaId: PromptBundleSchemaIdV1Schema.optional(),
    digest: z.string().min(1),
    displayPath: z.string().min(1),
  })
  .passthrough();
export type PromptAssetDiscoveryItemV1 = z.infer<typeof PromptAssetDiscoveryItemV1Schema>;

export const PromptAssetBundleRecordV1Schema = PromptAssetDiscoveryItemV1Schema.extend({
  libraryKind: z.literal('bundle'),
  bundleSchemaId: PromptBundleSchemaIdV1Schema,
  bundleBody: PromptBundleBodyV1Schema,
}).passthrough();
export type PromptAssetBundleRecordV1 = z.infer<typeof PromptAssetBundleRecordV1Schema>;

export const PromptAssetDocRecordV1Schema = PromptAssetDiscoveryItemV1Schema.extend({
  libraryKind: z.literal('doc'),
  markdown: z.string(),
}).passthrough();
export type PromptAssetDocRecordV1 = z.infer<typeof PromptAssetDocRecordV1Schema>;

export const PromptAssetMutationErrorCodeV1Schema = z.enum([
  'access_denied',
  'conflict',
  'internal_error',
  'invalid_request',
  'not_found',
  'unsupported',
]);
export type PromptAssetMutationErrorCodeV1 = z.infer<typeof PromptAssetMutationErrorCodeV1Schema>;

export const PromptAssetMutationPreviewV1Schema = z
  .object({
    operation: z.enum(['write', 'delete']),
    targetPath: z.string().min(1),
    fileCount: z.number().int().min(0),
  })
  .passthrough();
export type PromptAssetMutationPreviewV1 = z.infer<typeof PromptAssetMutationPreviewV1Schema>;

export const PromptAssetWriteBundleRequestSchema = z
  .object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).nullable().optional(),
    externalRef: PromptAssetExternalRefV1Schema.nullable().optional(),
    targetName: z.string().min(1),
    title: z.string().min(1),
    bundleSchemaId: PromptBundleSchemaIdV1Schema,
    bundleBody: PromptBundleBodyV1Schema,
    installMode: PromptAssetInstallModeV1Schema.optional(),
    previewOnly: z.boolean().optional(),
    expectedDigest: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type PromptAssetWriteBundleRequest = z.infer<typeof PromptAssetWriteBundleRequestSchema>;

export const PromptAssetWriteDocRequestSchema = z
  .object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).nullable().optional(),
    externalRef: PromptAssetExternalRefV1Schema.nullable().optional(),
    targetPath: z.string().min(1),
    title: z.string().min(1),
    markdown: z.string(),
    previewOnly: z.boolean().optional(),
    expectedDigest: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type PromptAssetWriteDocRequest = z.infer<typeof PromptAssetWriteDocRequestSchema>;

export const PromptAssetWriteRequestSchema = z.union([
  PromptAssetWriteBundleRequestSchema,
  PromptAssetWriteDocRequestSchema,
]);
export type PromptAssetWriteRequest = z.infer<typeof PromptAssetWriteRequestSchema>;

export const PromptAssetDeleteRequestSchema = z
  .object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).nullable().optional(),
    externalRef: PromptAssetExternalRefV1Schema,
    previewOnly: z.boolean().optional(),
    expectedDigest: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type PromptAssetDeleteRequest = z.infer<typeof PromptAssetDeleteRequestSchema>;

export const PromptAssetReadRequestSchema = z
  .object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).nullable().optional(),
    externalRef: PromptAssetExternalRefV1Schema,
  })
  .passthrough();
export type PromptAssetReadRequest = z.infer<typeof PromptAssetReadRequestSchema>;

export const PromptAssetDiscoverRequestSchema = z
  .object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type PromptAssetDiscoverRequest = z.infer<typeof PromptAssetDiscoverRequestSchema>;

export const PromptAssetMutationSuccessResponseV1Schema = z
  .object({
    ok: z.literal(true),
    externalRef: PromptAssetExternalRefV1Schema.optional(),
    digest: z.string().min(1).optional(),
    preview: PromptAssetMutationPreviewV1Schema.optional(),
  })
  .passthrough();

export const PromptAssetMutationErrorResponseV1Schema = z
  .object({
    ok: z.literal(false),
    errorCode: PromptAssetMutationErrorCodeV1Schema,
    error: z.string().min(1),
    currentDigest: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export const PromptAssetMutationResponseV1Schema = z.union([
  PromptAssetMutationSuccessResponseV1Schema,
  PromptAssetMutationErrorResponseV1Schema,
]);
export type PromptAssetMutationResponseV1 = z.infer<typeof PromptAssetMutationResponseV1Schema>;

export const PromptAssetListTypesResponseV1Schema = z
  .object({
    ok: z.literal(true),
    types: z.array(PromptAssetTypeDescriptorV1Schema),
  })
  .passthrough();
export type PromptAssetListTypesResponseV1 = z.infer<typeof PromptAssetListTypesResponseV1Schema>;

export const PromptAssetDiscoverResponseV1Schema = z
  .object({
    ok: z.literal(true),
    items: z.array(PromptAssetDiscoveryItemV1Schema),
  })
  .passthrough();
export type PromptAssetDiscoverResponseV1 = z.infer<typeof PromptAssetDiscoverResponseV1Schema>;

export const PromptAssetReadResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    item: z.union([PromptAssetBundleRecordV1Schema, PromptAssetDocRecordV1Schema]),
  }).passthrough(),
  PromptAssetMutationErrorResponseV1Schema,
]);
export type PromptAssetReadResponseV1 = z.infer<typeof PromptAssetReadResponseV1Schema>;
