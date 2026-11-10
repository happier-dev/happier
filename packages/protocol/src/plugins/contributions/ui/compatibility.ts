import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const PluginUiPlatformV1Schema = lazyZodSchema(() => z.enum([
  'android',
  'desktop',
  'ios',
  'web',
]));
export type PluginUiPlatformV1 = z.infer<typeof PluginUiPlatformV1Schema>;

export const PluginUiChannelV1Schema = lazyZodSchema(() => z.enum([
  'development',
  'desktop',
  'internal',
  'store',
]));
export type PluginUiChannelV1 = z.infer<typeof PluginUiChannelV1Schema>;

export const PluginUiCompatibilityV1Schema = lazyZodSchema(() => z.strictObject({
  platforms: z.optional(z.array(PluginUiPlatformV1Schema).check(z.minLength(1))),
  channels: z.optional(z.array(PluginUiChannelV1Schema).check(z.minLength(1))),
  featureGate: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type PluginUiCompatibilityV1 = z.infer<typeof PluginUiCompatibilityV1Schema>;
