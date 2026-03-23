import { z } from 'zod';

import { PromptBundleBodyV1Schema, PromptBundleSchemaIdV1Schema } from './promptBundleSchemas.js';
import {
  PromptAssetExternalRefV1Schema,
  PromptAssetInstallModeV1Schema,
  PromptAssetMutationErrorCodeV1Schema,
  PromptAssetMutationPreviewV1Schema,
  PromptAssetScopeV1Schema,
} from './promptAssetsV1.js';

export const PromptRegistryConfiguredSourceV1Schema = z.object({
  id: z.string().min(1),
  adapterId: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type PromptRegistryConfiguredSourceV1 = z.infer<typeof PromptRegistryConfiguredSourceV1Schema>;

export const PromptRegistrySourcesV1Schema = z
  .object({
    v: z.literal(1).default(1),
    sources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
  })
  .catch({ v: 1, sources: [] });
export type PromptRegistrySourcesV1 = z.infer<typeof PromptRegistrySourcesV1Schema>;

export const PromptRegistryAdapterDescriptorV1Schema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  supportsConfiguredSources: z.boolean().default(false),
  supportsQuery: z.boolean().default(false),
  minimumQueryLength: z.number().int().min(1).optional(),
});
export type PromptRegistryAdapterDescriptorV1 = z.infer<typeof PromptRegistryAdapterDescriptorV1Schema>;

export const PromptRegistrySourceDescriptorV1Schema = z.object({
  id: z.string().min(1),
  adapterId: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  origin: z.enum(['built_in', 'user']),
});
export type PromptRegistrySourceDescriptorV1 = z.infer<typeof PromptRegistrySourceDescriptorV1Schema>;

export const PromptRegistryItemSummaryV1Schema = z.object({
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  bundleSchemaId: PromptBundleSchemaIdV1Schema,
  displayPath: z.string().min(1),
  providerHints: z.array(z.string().min(1)).optional(),
});
export type PromptRegistryItemSummaryV1 = z.infer<typeof PromptRegistryItemSummaryV1Schema>;

export const PromptRegistryFetchedItemV1Schema = z.object({
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  bundleSchemaId: PromptBundleSchemaIdV1Schema,
  bundleBody: PromptBundleBodyV1Schema,
});
export type PromptRegistryFetchedItemV1 = z.infer<typeof PromptRegistryFetchedItemV1Schema>;

export const PromptRegistryListSourcesRequestV1Schema = z.object({
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
});
export type PromptRegistryListSourcesRequestV1 = z.infer<typeof PromptRegistryListSourcesRequestV1Schema>;

export const PromptRegistryScanSourceRequestV1Schema = z.object({
  sourceId: z.string().min(1),
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
  query: z.string().trim().min(1).nullable().optional(),
});
export type PromptRegistryScanSourceRequestV1 = z.infer<typeof PromptRegistryScanSourceRequestV1Schema>;

export const PromptRegistryFetchItemRequestV1Schema = z.object({
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
});
export type PromptRegistryFetchItemRequestV1 = z.infer<typeof PromptRegistryFetchItemRequestV1Schema>;

export const PromptRegistryInstallTargetV1Schema = z.object({
  assetTypeId: z.string().min(1),
  scope: PromptAssetScopeV1Schema,
  directory: z.string().min(1).optional(),
  targetName: z.string().min(1),
  installMode: PromptAssetInstallModeV1Schema.optional(),
});
export type PromptRegistryInstallTargetV1 = z.infer<typeof PromptRegistryInstallTargetV1Schema>;

export const PromptRegistryInstallRequestV1Schema = z.object({
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
  installTarget: PromptRegistryInstallTargetV1Schema,
  previewOnly: z.boolean().optional(),
  expectedDigest: z.string().min(1).nullable().optional(),
});
export type PromptRegistryInstallRequestV1 = z.infer<typeof PromptRegistryInstallRequestV1Schema>;

export const PromptRegistryErrorCodeV1Schema = z.enum([
  'internal_error',
  'invalid_request',
  'not_found',
  'unsupported',
]);
export type PromptRegistryErrorCodeV1 = z.infer<typeof PromptRegistryErrorCodeV1Schema>;

export const PromptRegistryErrorResponseV1Schema = z.object({
  ok: z.literal(false),
  errorCode: PromptRegistryErrorCodeV1Schema,
  error: z.string().min(1),
});
export type PromptRegistryErrorResponseV1 = z.infer<typeof PromptRegistryErrorResponseV1Schema>;

export const PromptRegistryListAdaptersResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    adapters: z.array(PromptRegistryAdapterDescriptorV1Schema),
  }),
  PromptRegistryErrorResponseV1Schema,
]);
export type PromptRegistryListAdaptersResponseV1 = z.infer<typeof PromptRegistryListAdaptersResponseV1Schema>;

export const PromptRegistryListSourcesResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    sources: z.array(PromptRegistrySourceDescriptorV1Schema),
  }),
  PromptRegistryErrorResponseV1Schema,
]);
export type PromptRegistryListSourcesResponseV1 = z.infer<typeof PromptRegistryListSourcesResponseV1Schema>;

export const PromptRegistryScanSourceResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    items: z.array(PromptRegistryItemSummaryV1Schema),
  }),
  PromptRegistryErrorResponseV1Schema,
]);
export type PromptRegistryScanSourceResponseV1 = z.infer<typeof PromptRegistryScanSourceResponseV1Schema>;

export const PromptRegistryFetchItemResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    item: PromptRegistryFetchedItemV1Schema,
  }),
  PromptRegistryErrorResponseV1Schema,
]);
export type PromptRegistryFetchItemResponseV1 = z.infer<typeof PromptRegistryFetchItemResponseV1Schema>;

export const PromptRegistryInstallResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    externalRef: PromptAssetExternalRefV1Schema.optional(),
    digest: z.string().min(1).optional(),
    preview: PromptAssetMutationPreviewV1Schema.optional(),
  }),
  z.object({
    ok: z.literal(false),
    errorCode: PromptAssetMutationErrorCodeV1Schema,
    error: z.string().min(1),
    currentDigest: z.string().min(1).nullable().optional(),
  }),
]);
export type PromptRegistryInstallResponseV1 = z.infer<typeof PromptRegistryInstallResponseV1Schema>;
