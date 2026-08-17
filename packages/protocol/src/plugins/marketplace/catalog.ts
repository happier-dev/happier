import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginIdSchema } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginMarketplaceSourceKindV1Schema = z.enum(['curated', 'user']);
export type PluginMarketplaceSourceKindV1 = z.infer<typeof PluginMarketplaceSourceKindV1Schema>;

export const PluginMarketplaceEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  manifestId: asProtocolZod(PluginIdSchema),
  title: z.string().trim().min(1),
  version: PluginOptionalStringSchema,
  description: PluginOptionalStringSchema,
  sourceUrl: z.string().trim().min(1),
  packageUrl: PluginOptionalStringSchema,
  digest: PluginOptionalStringSchema,
  categories: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginMarketplaceEntryV1 = z.infer<typeof PluginMarketplaceEntryV1Schema>;

export const PluginMarketplaceCatalogV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  sourceKind: PluginMarketplaceSourceKindV1Schema.default('user'),
  sourceUrl: PluginOptionalStringSchema,
  entries: z.array(PluginMarketplaceEntryV1Schema).default([]),
}).strict();
export type PluginMarketplaceCatalogV1 = z.infer<typeof PluginMarketplaceCatalogV1Schema>;

export const PluginManifestMarketplaceMetadataV1Schema = z.object({
  sourceUrl: PluginOptionalStringSchema,
  categories: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginManifestMarketplaceMetadataV1 = z.infer<typeof PluginManifestMarketplaceMetadataV1Schema>;
