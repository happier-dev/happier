import { z } from 'zod';

import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

export const PluginUiArtifactCompatibilityKeyV1Schema = z.object({
  hostAppVersion: ExactRuntimeVersionSchema,
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema.optional(),
  reactNativeVersion: ExactRuntimeVersionSchema.optional(),
  expoRuntimeVersion: ExactRuntimeVersionSchema.optional(),
  hermesVersion: ExactRuntimeVersionSchema.optional(),
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  nativeCapabilities: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiArtifactCompatibilityKeyV1 =
  z.infer<typeof PluginUiArtifactCompatibilityKeyV1Schema>;

export { ExactRuntimeVersionSchema as PluginUiExactRuntimeVersionV1Schema };
