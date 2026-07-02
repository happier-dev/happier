import { z } from 'zod';

import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';
import { PluginUiFallbackRefV1Schema } from './actions.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from './compatibility.js';
import { PluginUiDisplayV1Schema } from './tokens.js';

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

export const PluginReactNativeBundleIntegrityV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
  signature: z.string().trim().min(1).optional(),
  signingKeyId: z.string().trim().min(1).optional(),
}).strict();
export type PluginReactNativeBundleIntegrityV1 = z.infer<typeof PluginReactNativeBundleIntegrityV1Schema>;

export const PluginReactNativeBundleArtifactRefV1Schema = z.object({
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  url: z.string().trim().min(1).optional(),
  assetPath: z.string().trim().min(1).optional(),
  integrity: PluginReactNativeBundleIntegrityV1Schema,
  bytecode: z.object({
    kind: z.literal('hermes'),
    hermesVersion: ExactRuntimeVersionSchema,
  }).strict().optional(),
  sourceMap: z.object({
    digest: PluginUiArtifactDigestV1Schema,
    url: z.string().trim().min(1).optional(),
    assetPath: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict();
export type PluginReactNativeBundleArtifactRefV1 = z.infer<typeof PluginReactNativeBundleArtifactRefV1Schema>;

export const PluginReactNativeBundleEntryV1Schema = z.object({
  exportName: z.string().trim().min(1),
}).strict();
export type PluginReactNativeBundleEntryV1 = z.infer<typeof PluginReactNativeBundleEntryV1Schema>;

export const PluginReactNativeBundleCompatibilityV1Schema = z.object({
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema,
  reactNativeVersion: ExactRuntimeVersionSchema,
  expoRuntimeVersion: ExactRuntimeVersionSchema.optional(),
  hermesVersion: ExactRuntimeVersionSchema.optional(),
  supportedPlatforms: z.array(PluginUiPlatformV1Schema).min(1),
  supportedChannels: z.array(PluginUiChannelV1Schema).min(1),
  requiredNativeCapabilities: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginReactNativeBundleCompatibilityV1 = z.infer<typeof PluginReactNativeBundleCompatibilityV1Schema>;

export const PluginReactNativeHostApiRequirementV1Schema = z.object({
  minVersion: ExactRuntimeVersionSchema,
  methods: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginReactNativeHostApiRequirementV1 = z.infer<typeof PluginReactNativeHostApiRequirementV1Schema>;

export const PluginReactNativeBundlePolicyV1Schema = z.object({
  allowDevHotReload: z.boolean().default(false),
  crashThreshold: z.number().int().positive().optional(),
  loadTimeoutMs: z.number().int().positive().optional(),
}).strict();
export type PluginReactNativeBundlePolicyV1 = z.infer<typeof PluginReactNativeBundlePolicyV1Schema>;

export const PluginReactNativeBundleContributionV1Schema = z.object({
  id: z.string().trim().min(1),
  bundle: PluginReactNativeBundleArtifactRefV1Schema,
  entry: PluginReactNativeBundleEntryV1Schema,
  compatibility: PluginReactNativeBundleCompatibilityV1Schema,
  hostApi: PluginReactNativeHostApiRequirementV1Schema,
  nativeCapabilities: z.array(z.string().trim().min(1)).default([]),
  fallback: PluginUiFallbackRefV1Schema,
  display: PluginUiDisplayV1Schema,
  policy: PluginReactNativeBundlePolicyV1Schema.optional(),
}).strict();
export type PluginReactNativeBundleContributionV1 = z.infer<typeof PluginReactNativeBundleContributionV1Schema>;
