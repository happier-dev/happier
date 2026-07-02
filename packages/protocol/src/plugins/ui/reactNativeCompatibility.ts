import { z } from 'zod';

import { PluginUiFallbackRefV1Schema } from '../contributions/ui/actions.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

export const PluginReactNativeCompatibilityInputV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  artifactDigest: z.string().trim().min(1),
  hostAppVersion: ExactRuntimeVersionSchema,
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema,
  reactNativeVersion: ExactRuntimeVersionSchema,
  expoRuntimeVersion: ExactRuntimeVersionSchema.optional(),
  hermesVersion: ExactRuntimeVersionSchema.optional(),
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  availableNativeCapabilities: z.array(z.string().trim().min(1)).default([]),
  requiredNativeCapabilities: z.array(z.string().trim().min(1)).default([]),
  featureState: z.enum(['enabled', 'disabled', 'unknown']),
  previousCrashCount: z.number().int().nonnegative().default(0),
}).strict();
export type PluginReactNativeCompatibilityInputV1 =
  z.infer<typeof PluginReactNativeCompatibilityInputV1Schema>;

export const PluginReactNativeCompatibilityDecisionStateV1Schema = z.enum([
  'load',
  'fallback',
  'disabled',
  'blocked',
]);
export type PluginReactNativeCompatibilityDecisionStateV1 =
  z.infer<typeof PluginReactNativeCompatibilityDecisionStateV1Schema>;

export const PluginReactNativeCompatibilityDecisionReasonV1Schema = z.enum([
  'compatible',
  'feature_disabled',
  'channel_policy_denied',
  'runtime_mismatch',
  'missing_native_capability',
  'artifact_revoked',
  'crash_disabled',
  'unknown',
]);
export type PluginReactNativeCompatibilityDecisionReasonV1 =
  z.infer<typeof PluginReactNativeCompatibilityDecisionReasonV1Schema>;

export const PluginReactNativeCompatibilityDecisionV1Schema = z.object({
  state: PluginReactNativeCompatibilityDecisionStateV1Schema,
  reason: PluginReactNativeCompatibilityDecisionReasonV1Schema,
  fallback: PluginUiFallbackRefV1Schema.optional(),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginReactNativeCompatibilityDecisionV1 =
  z.infer<typeof PluginReactNativeCompatibilityDecisionV1Schema>;
