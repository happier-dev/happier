import { z } from 'zod';
import { utf8ToBytes } from '@noble/hashes/utils';

import {
  computePluginUiArtifactSha256DigestV1,
  type PluginUiArtifactDigestV1,
} from './artifactIntegrity.js';

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

/**
 * One runtime-independent cache-binding digest for an Artifact's declared
 * native capabilities. Both daemon projections and direct UI target reads
 * consume this exact normalized representation.
 */
export function derivePluginUiNativeCapabilitiesDigestV1(
  capabilities: readonly string[],
): PluginUiArtifactDigestV1 {
  const normalized = [...capabilities]
    .map((capability) => capability.trim())
    .filter(Boolean)
    .sort();
  return computePluginUiArtifactSha256DigestV1(
    utf8ToBytes(JSON.stringify(normalized)),
  );
}

export { ExactRuntimeVersionSchema as PluginUiExactRuntimeVersionV1Schema };
