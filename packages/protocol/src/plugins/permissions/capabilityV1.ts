import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1 = [
  'credentials.materialize.raw',
] as const;

// Retained for stored grant rows; review comments no longer consume this legacy grant.
export const PluginPermissionCapabilityV1Schema = lazyZodSchema(() => z.enum([...PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1, 'reviews.comments.write.direct']));
export type PluginPermissionCapabilityV1 = z.infer<typeof PluginPermissionCapabilityV1Schema>;
