import { z } from 'zod';

import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../_shared.js';
import { PluginEventLocalIdV1Schema } from '../events/v1.js';

export const PluginEventContributionV1Schema = z.object({
  id: PluginEventLocalIdV1Schema,
  payloadSchema: PluginLooseJsonObjectSchema.optional(),
  description: PluginOptionalStringSchema,
  deprecated: z.boolean().default(false),
}).strict();
export type PluginEventContributionV1 = z.input<typeof PluginEventContributionV1Schema>;
export type ParsedPluginEventContributionV1 = z.output<typeof PluginEventContributionV1Schema>;
