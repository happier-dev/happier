import { z } from 'zod';

import { OptionalStringSchema } from '../_shared.js';
import { ExtensionResourceKindV2Schema } from '../contributions/v2.js';

export const ExtensionResourcePackageItemV1Schema = z.object({
  kind: ExtensionResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: OptionalStringSchema,
  contentType: OptionalStringSchema,
}).strict();
export type ExtensionResourcePackageItemV1 = z.infer<typeof ExtensionResourcePackageItemV1Schema>;

export const ExtensionResourcePackageV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  resources: z.array(ExtensionResourcePackageItemV1Schema).default([]),
}).strict();
export type ExtensionResourcePackageV1 = z.infer<typeof ExtensionResourcePackageV1Schema>;
