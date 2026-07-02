import { z } from 'zod';

import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from './compatibility.js';

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

export const PluginUiArtifactIntegrityV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
  signature: z.string().trim().min(1).optional(),
  signingKeyId: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiArtifactIntegrityV1 = z.infer<typeof PluginUiArtifactIntegrityV1Schema>;

export const PluginUiArtifactCompatibilityV1Schema = z.object({
  hostAppVersion: ExactRuntimeVersionSchema,
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema.optional(),
  reactNativeVersion: ExactRuntimeVersionSchema.optional(),
  expoRuntimeVersion: ExactRuntimeVersionSchema.optional(),
  hermesVersion: ExactRuntimeVersionSchema.optional(),
  nativeCapabilities: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiArtifactCompatibilityV1 = z.infer<typeof PluginUiArtifactCompatibilityV1Schema>;

export const PluginUiArtifactKindV1Schema = z.enum([
  'hostedWebAsset',
  'reactNativeBundle',
  'reactNativeSourceMap',
]);
export type PluginUiArtifactKindV1 = z.infer<typeof PluginUiArtifactKindV1Schema>;

export const PluginUiArtifactContributionFamilyV1Schema = z.enum([
  'hostedWeb',
  'reactNativeBundles',
]);
export type PluginUiArtifactContributionFamilyV1 =
  z.infer<typeof PluginUiArtifactContributionFamilyV1Schema>;

export const PluginUiArtifactContributionV1Schema = z.object({
  id: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  contributionFamily: PluginUiArtifactContributionFamilyV1Schema,
  artifactKind: PluginUiArtifactKindV1Schema,
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  integrity: PluginUiArtifactIntegrityV1Schema,
  compatibility: PluginUiArtifactCompatibilityV1Schema,
  byteSize: z.number().int().positive(),
  contentType: z.string().trim().min(1),
  assetPath: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  cacheKey: z.string().trim().min(1).optional(),
  revokedAt: z.string().datetime().optional(),
  devUrl: z.string().trim().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.channel !== 'development' && value.devUrl !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['devUrl'],
      message: 'devUrl is only allowed for development-channel plugin UI artifacts',
    });
  }

  if (
    (value.artifactKind === 'reactNativeBundle' ||
      value.artifactKind === 'reactNativeSourceMap') &&
    value.contributionFamily !== 'reactNativeBundles'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contributionFamily'],
      message: `${value.artifactKind} artifacts must belong to reactNativeBundles contributions`,
    });
  }

  if (value.artifactKind === 'hostedWebAsset' && value.contributionFamily !== 'hostedWeb') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contributionFamily'],
      message: 'hostedWebAsset artifacts must belong to hostedWeb contributions',
    });
  }
});
export type PluginUiArtifactContributionV1 = z.infer<typeof PluginUiArtifactContributionV1Schema>;
