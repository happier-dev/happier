import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1 = [
  'reviews.comments.write.direct',
  'credentials.materialize.raw',
] as const;

export const PluginPermissionCapabilityV1Schema = lazyZodSchema(() => z.enum(PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1));
export type PluginPermissionCapabilityV1 = z.infer<typeof PluginPermissionCapabilityV1Schema>;
