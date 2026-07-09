import { z } from 'zod';

import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';
import { PluginUiHostApiMethodV1Schema } from '../../ui/hostApi.js';
import { PluginUiFallbackRefV1Schema } from './actions.js';
import { PluginUiChannelV1Schema } from './compatibility.js';
import { PluginUiDisplayV1Schema } from './tokens.js';

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

// RN-WEB-LOADER / LEDGER DEC-6: 'web' is a first-class reactNative bundle
// platform — the SAME contribution family, an additional entry per
// contribution (mirrors the existing ios+android multi-entry pattern),
// compiled through react-native-web instead of Re.Pack. See
// `packages/plugin-sdk/src/ui/reactNativeWebBuild.ts` (build preset) and
// `packages/protocol/src/plugins/ui/uiArtifactsManifest.ts` (artifact
// manifest superRefine) for the build/artifact-side counterparts.
const PluginReactNativeBundlePlatformV1Schema = z.enum(['ios', 'android', 'web']);

export const PluginReactNativeBundleIntegrityV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
  signature: z.string().trim().min(1).optional(),
  signingKeyId: z.string().trim().min(1).optional(),
}).strict();
export type PluginReactNativeBundleIntegrityV1 = z.infer<typeof PluginReactNativeBundleIntegrityV1Schema>;

export const PluginReactNativeBundleArtifactRefV1Schema = z.object({
  platform: PluginReactNativeBundlePlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  url: z.string().trim().min(1).optional(),
  assetPath: z.string().trim().min(1).optional(),
  integrity: PluginReactNativeBundleIntegrityV1Schema.optional(),
  bytecode: z.never().optional(),
  sourceMap: z.object({
    digest: PluginUiArtifactDigestV1Schema,
    url: z.string().trim().min(1).optional(),
    assetPath: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict();
export type PluginReactNativeBundleArtifactRefV1 = z.infer<typeof PluginReactNativeBundleArtifactRefV1Schema>;

export const PluginReactNativeBundleEntryV1Schema = z.object({
  containerName: z.string().trim().min(1).optional(),
  modulePath: z.string().trim().min(1).default('./renderSurface'),
  exportName: z.string().trim().min(1).default('renderSurface'),
}).strict();
export type PluginReactNativeBundleEntryV1 = z.infer<typeof PluginReactNativeBundleEntryV1Schema>;

export const PluginReactNativeBundleCompatibilityV1Schema = z.object({
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema,
  reactNativeVersion: ExactRuntimeVersionSchema,
  expoRuntimeVersion: ExactRuntimeVersionSchema.optional(),
  hermesVersion: ExactRuntimeVersionSchema.optional(),
  supportedPlatforms: z.array(PluginReactNativeBundlePlatformV1Schema).min(1),
  supportedChannels: z.array(PluginUiChannelV1Schema).min(1),
  requiredNativeCapabilities: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginReactNativeBundleCompatibilityV1 = z.infer<typeof PluginReactNativeBundleCompatibilityV1Schema>;

export const PluginReactNativeHostApiRequirementV1Schema = z.object({
  minVersion: ExactRuntimeVersionSchema,
  methods: z.array(PluginUiHostApiMethodV1Schema).default([]),
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
}).strict().superRefine((value, ctx) => {
  if (!value.compatibility.supportedPlatforms.includes(value.bundle.platform)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compatibility', 'supportedPlatforms'],
      message: 'React Native bundle compatibility must include the artifact platform',
    });
  }
  if (
    !value.bundle.integrity
    && (
      value.bundle.channel !== 'development'
      || value.bundle.assetPath !== undefined
      || value.bundle.url !== undefined
      || value.policy?.allowDevHotReload !== true
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bundle', 'integrity'],
      message: 'React Native bundle integrity is required except for local development hot-reload declarations',
    });
  }
});
export type PluginReactNativeBundleContributionV1 = z.infer<typeof PluginReactNativeBundleContributionV1Schema>;
