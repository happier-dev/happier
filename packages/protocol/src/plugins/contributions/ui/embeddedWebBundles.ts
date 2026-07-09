import { z } from 'zod';

import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';
import { PluginUiChannelV1Schema } from './compatibility.js';
import { PluginUiDisplayV1Schema } from './tokens.js';

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

export const PluginEmbeddedWebBundlePlatformV1Schema = z.literal('web');
export type PluginEmbeddedWebBundlePlatformV1 = z.infer<typeof PluginEmbeddedWebBundlePlatformV1Schema>;

export const PluginEmbeddedWebBundleIntegrityV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
  signature: z.string().trim().min(1).optional(),
  signingKeyId: z.string().trim().min(1).optional(),
}).strict();
export type PluginEmbeddedWebBundleIntegrityV1 = z.infer<typeof PluginEmbeddedWebBundleIntegrityV1Schema>;

export const PluginEmbeddedWebBundleArtifactRefV1Schema = z.object({
  platform: PluginEmbeddedWebBundlePlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  // `assetPath`/`integrity` are required for an immutable installed bundle. They are
  // optional ONLY to represent a local development hot-reload declaration (no built
  // artifact exists yet) — see the contribution-level superRefine below, which mirrors
  // the React Native bundle contribution's identical carve-out.
  assetPath: z.string().trim().min(1).optional(),
  integrity: PluginEmbeddedWebBundleIntegrityV1Schema.optional(),
  sourceMap: z.object({
    digest: PluginUiArtifactDigestV1Schema,
    assetPath: z.string().trim().min(1),
  }).strict().optional(),
}).strict();
export type PluginEmbeddedWebBundleArtifactRefV1 = z.infer<typeof PluginEmbeddedWebBundleArtifactRefV1Schema>;

export const PluginEmbeddedWebBundleEntryV1Schema = z.object({
  mechanism: z.literal('hostRuntimeFactoryV1'),
}).strict();
export type PluginEmbeddedWebBundleEntryV1 = z.infer<typeof PluginEmbeddedWebBundleEntryV1Schema>;

export const PluginEmbeddedWebBundleCompatibilityV1Schema = z.object({
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema,
  hostAppVersion: ExactRuntimeVersionSchema,
  supportedPlatforms: z.array(PluginEmbeddedWebBundlePlatformV1Schema).min(1),
  supportedChannels: z.array(PluginUiChannelV1Schema).min(1),
}).strict();
export type PluginEmbeddedWebBundleCompatibilityV1 =
  z.infer<typeof PluginEmbeddedWebBundleCompatibilityV1Schema>;

export const PluginEmbeddedWebHostApiRequirementV1Schema = z.object({
  minVersion: ExactRuntimeVersionSchema,
  methods: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginEmbeddedWebHostApiRequirementV1 =
  z.infer<typeof PluginEmbeddedWebHostApiRequirementV1Schema>;

export const PluginEmbeddedWebBundlePolicyV1Schema = z.object({
  allowDevHotReload: z.boolean().default(false),
  crashThreshold: z.number().int().positive().optional(),
  loadTimeoutMs: z.number().int().positive().optional(),
}).strict();
export type PluginEmbeddedWebBundlePolicyV1 = z.infer<typeof PluginEmbeddedWebBundlePolicyV1Schema>;

export const PluginEmbeddedWebBundleFallbackRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hostedWeb'),
    contributionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('descriptor'),
    descriptorId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginEmbeddedWebBundleFallbackRefV1 =
  z.infer<typeof PluginEmbeddedWebBundleFallbackRefV1Schema>;

export const PluginEmbeddedWebBundleContributionV1Schema = z.object({
  id: z.string().trim().min(1),
  bundle: PluginEmbeddedWebBundleArtifactRefV1Schema,
  entry: PluginEmbeddedWebBundleEntryV1Schema,
  compatibility: PluginEmbeddedWebBundleCompatibilityV1Schema,
  hostApi: PluginEmbeddedWebHostApiRequirementV1Schema,
  fallback: PluginEmbeddedWebBundleFallbackRefV1Schema,
  display: PluginUiDisplayV1Schema,
  policy: PluginEmbeddedWebBundlePolicyV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.compatibility.supportedPlatforms.includes(value.bundle.platform)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compatibility', 'supportedPlatforms'],
      message: 'Embedded web bundle compatibility must include the web artifact platform',
    });
  }
  // Mirrors the React Native bundle contribution's identical carve-out: an immutable
  // installed bundle always requires integrity, EXCEPT a local development-channel
  // hot-reload declaration that has no built artifact yet (no assetPath, explicit
  // `policy.allowDevHotReload`).
  if (
    !value.bundle.integrity
    && (
      value.bundle.channel !== 'development'
      || value.bundle.assetPath !== undefined
      || value.policy?.allowDevHotReload !== true
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bundle', 'integrity'],
      message: 'Embedded web bundle integrity is required except for local development hot-reload declarations',
    });
  }
});
export type PluginEmbeddedWebBundleContributionV1 =
  z.infer<typeof PluginEmbeddedWebBundleContributionV1Schema>;
