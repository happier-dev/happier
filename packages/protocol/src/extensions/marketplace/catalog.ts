import { z } from 'zod';

import { OptionalStringSchema } from '../_shared.js';
import { ExtensionIdSchema } from '../extensionId.js';

export const ExtensionMarketplaceSourceKindV1Schema = z.enum(['curated', 'user']);
export type ExtensionMarketplaceSourceKindV1 = z.infer<typeof ExtensionMarketplaceSourceKindV1Schema>;

export const ExtensionMarketplaceEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  manifestId: ExtensionIdSchema,
  title: z.string().trim().min(1),
  version: OptionalStringSchema,
  description: OptionalStringSchema,
  sourceUrl: z.string().trim().min(1),
  packageUrl: OptionalStringSchema,
  digest: OptionalStringSchema,
  categories: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ExtensionMarketplaceEntryV1 = z.infer<typeof ExtensionMarketplaceEntryV1Schema>;

export const ExtensionMarketplaceCatalogV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  sourceKind: ExtensionMarketplaceSourceKindV1Schema.default('user'),
  sourceUrl: OptionalStringSchema,
  entries: z.array(ExtensionMarketplaceEntryV1Schema).default([]),
}).strict();
export type ExtensionMarketplaceCatalogV1 = z.infer<typeof ExtensionMarketplaceCatalogV1Schema>;

export const ExtensionManifestMarketplaceMetadataV1Schema = z.object({
  sourceUrl: OptionalStringSchema,
  categories: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ExtensionManifestMarketplaceMetadataV1 = z.infer<typeof ExtensionManifestMarketplaceMetadataV1Schema>;
