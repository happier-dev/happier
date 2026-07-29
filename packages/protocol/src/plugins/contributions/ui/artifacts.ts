import { z } from 'zod';

import { isPortableRelativePath } from '../../../filesystem/portablePathSegment.js';
import { PluginUiArtifactDigestV1Schema } from '../../ui/artifactIntegrity.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from './compatibility.js';

export const PluginUiArtifactRelativePathV1Schema = z.string().min(1).refine(
  isPortableRelativePath,
  { message: 'artifact file paths must use portable relative path segments' },
);

const ExactRuntimeVersionSchema = z.string().trim().min(1).refine(
  (value) => value !== '*' && !value.includes('x'),
  { message: 'runtime compatibility versions must be exact' },
);

export const PluginUiArtifactIntegrityV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
}).strict();
export type PluginUiArtifactIntegrityV1 = z.infer<typeof PluginUiArtifactIntegrityV1Schema>;

export const PluginUiArtifactFileV1Schema = z.object({
  relativePath: PluginUiArtifactRelativePathV1Schema,
  digest: PluginUiArtifactDigestV1Schema,
  byteSize: z.number().int().positive(),
}).strict();
export type PluginUiArtifactFileV1 = z.infer<typeof PluginUiArtifactFileV1Schema>;

export const PluginUiArtifactCompatibilityV1Schema = z.object({
  hostAppVersion: ExactRuntimeVersionSchema,
  hostUiApiVersion: ExactRuntimeVersionSchema,
  reactVersion: ExactRuntimeVersionSchema.optional(),
  reactNativeVersion: ExactRuntimeVersionSchema.optional(),
  expoRuntimeVersion: ExactRuntimeVersionSchema.optional(),
  hermesVersion: ExactRuntimeVersionSchema.optional(),
  // RN-HARDEN item 2 (channel compat gate): the artifact's DECLARATION of
  // which client channels may load it — the single channel-gate authority.
  // The artifact's top-level `channel` field is provenance metadata only
  // (which channel the artifact was built/published for), never a gate
  // input. Gates fail closed when this is absent/empty for non-first-party
  // artifacts (see apps/cli install/ui gate).
  supportedChannels: z.array(PluginUiChannelV1Schema).min(1).optional(),
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
  integrity: PluginUiArtifactIntegrityV1Schema.optional(),
  compatibility: PluginUiArtifactCompatibilityV1Schema,
  byteSize: z.number().int().nonnegative(),
  contentType: z.string().trim().min(1),
  assetPath: z.string().trim().min(1).optional(),
  files: z.array(PluginUiArtifactFileV1Schema).min(1).optional(),
  url: z.string().trim().min(1).optional(),
  cacheKey: z.string().trim().min(1).optional(),
  devUrl: z.string().trim().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  const isDevelopmentDevUrlArtifact = value.channel === 'development'
    && value.devUrl !== undefined
    && value.assetPath === undefined
    && value.url === undefined;

  if (!value.integrity && !isDevelopmentDevUrlArtifact) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['integrity'],
      message: 'Plugin UI artifact integrity is required except for development devUrl artifacts',
    });
  }

  if (value.byteSize <= 0 && !isDevelopmentDevUrlArtifact) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['byteSize'],
      message: 'Plugin UI artifact byteSize must be positive except for development devUrl artifacts',
    });
  }

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
