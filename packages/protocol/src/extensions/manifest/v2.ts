import { z } from 'zod';

import { OptionalStringSchema } from '../_shared.js';
import { ExtensionContributionV2Schema } from '../contributions/v2.js';
import { ExtensionIdSchema } from '../extensionId.js';
import { ExtensionSourceSpecV1Schema } from '../extensionSourceSpecV1.js';
import { ExtensionManifestMarketplaceMetadataV1Schema } from '../marketplace/catalog.js';
import { ExtensionPermissionDeclarationV1Schema } from '../permissions/v1.js';
import { ExtensionRuntimeApiV1Schema } from '../runtime/api.js';

export const ExtensionDaemonTargetV2Schema = z.object({
  entry: z.string().trim().min(1),
}).strict();
export type ExtensionDaemonTargetV2 = z.infer<typeof ExtensionDaemonTargetV2Schema>;

export const ExtensionEnginesV2Schema = z.object({
  happier: z.string().trim().min(1),
}).strict();
export type ExtensionEnginesV2 = z.infer<typeof ExtensionEnginesV2Schema>;

export const ExtensionTargetsV2Schema = z.object({
  daemon: ExtensionDaemonTargetV2Schema.optional(),
}).strict();
export type ExtensionTargetsV2 = z.infer<typeof ExtensionTargetsV2Schema>;

export const ExtensionManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: ExtensionIdSchema,
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: OptionalStringSchema,
  engines: ExtensionEnginesV2Schema,
  runtime: ExtensionRuntimeApiV1Schema,
  targets: ExtensionTargetsV2Schema.default({}),
  permissions: z.array(ExtensionPermissionDeclarationV1Schema).default([]),
  source: ExtensionSourceSpecV1Schema.optional(),
  marketplace: ExtensionManifestMarketplaceMetadataV1Schema.optional(),
  contributions: z.array(ExtensionContributionV2Schema).default([]),
}).strict();
export type ExtensionManifestV2 = z.infer<typeof ExtensionManifestV2Schema>;
