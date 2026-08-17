import { z } from 'zod';

export const PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1 = [
  'filesystem.read',
  'filesystem.write',
  'env',
  'network',
  'network.intercept',
  'process.spawn',
  'reviews.comments.write.direct',
  'credentials.materialize.raw',
] as const;

export const PluginPermissionCapabilityV1Schema = z.enum(PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1);
export type PluginPermissionCapabilityV1 = z.infer<typeof PluginPermissionCapabilityV1Schema>;
