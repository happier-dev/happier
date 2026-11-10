import { z } from '../../zodRuntimePolicy.js';

import { PluginUiFallbackRefV1Schema } from '../contributions/ui/actions.js';

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
  'unknown',
]);
export type PluginReactNativeCompatibilityDecisionReasonV1 =
  z.infer<typeof PluginReactNativeCompatibilityDecisionReasonV1Schema>;

export const PluginReactNativeCompatibilityDecisionV1Schema = z.strictObject({
  state: PluginReactNativeCompatibilityDecisionStateV1Schema,
  reason: PluginReactNativeCompatibilityDecisionReasonV1Schema,
  fallback: z.optional(PluginUiFallbackRefV1Schema),
  diagnostics: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
});
export type PluginReactNativeCompatibilityDecisionV1 =
  z.infer<typeof PluginReactNativeCompatibilityDecisionV1Schema>;
