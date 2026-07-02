import { z } from 'zod';

export const PluginUiPlatformV1Schema = z.enum([
  'android',
  'desktop',
  'ios',
  'web',
]);
export type PluginUiPlatformV1 = z.infer<typeof PluginUiPlatformV1Schema>;

export const PluginUiChannelV1Schema = z.enum([
  'development',
  'desktop',
  'internal',
  'store',
]);
export type PluginUiChannelV1 = z.infer<typeof PluginUiChannelV1Schema>;

export const PluginUiCompatibilityV1Schema = z.object({
  platforms: z.array(PluginUiPlatformV1Schema).min(1).optional(),
  channels: z.array(PluginUiChannelV1Schema).min(1).optional(),
  featureGate: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiCompatibilityV1 = z.infer<typeof PluginUiCompatibilityV1Schema>;
