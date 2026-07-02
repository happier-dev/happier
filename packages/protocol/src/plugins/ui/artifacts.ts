import { z } from 'zod';

import {
  PluginUiArtifactCompatibilityV1Schema,
  PluginUiArtifactContributionFamilyV1Schema,
  PluginUiArtifactKindV1Schema,
} from '../contributions/ui/artifacts.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import {
  PluginUiArtifactDigestV1Schema,
  PluginUiArtifactIntegrityBindingV1Schema,
} from './artifactIntegrity.js';

export const PluginUiExecutableArtifactManifestV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  contributionFamily: PluginUiArtifactContributionFamilyV1Schema,
  artifactKind: PluginUiArtifactKindV1Schema,
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  integrity: PluginUiArtifactIntegrityBindingV1Schema.omit({
    pluginId: true,
    contributionId: true,
    artifactKind: true,
  }),
  compatibility: PluginUiArtifactCompatibilityV1Schema,
  byteSize: z.number().int().positive(),
  contentType: z.string().trim().min(1),
  assetPath: z.string().trim().min(1).optional(),
  url: z.string().trim().url().optional(),
  sourceMapDigest: PluginUiArtifactDigestV1Schema.optional(),
  cacheKey: z.string().trim().min(1).optional(),
  installSourceId: z.string().trim().min(1).optional(),
  devUrl: z.string().trim().url().optional(),
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
export type PluginUiExecutableArtifactManifestV1 =
  z.infer<typeof PluginUiExecutableArtifactManifestV1Schema>;

export function derivePluginUiArtifactCacheKeyV1(
  artifact: PluginUiExecutableArtifactManifestV1,
): string {
  const nativeCapabilityKey = [...artifact.compatibility.nativeCapabilities].sort().join(',');
  return [
    artifact.pluginId,
    artifact.contributionId,
    artifact.artifactKind,
    artifact.platform,
    artifact.channel,
    artifact.integrity.digest,
    artifact.compatibility.hostAppVersion,
    artifact.compatibility.hostUiApiVersion,
    artifact.compatibility.reactVersion ?? '',
    artifact.compatibility.reactNativeVersion ?? '',
    artifact.compatibility.expoRuntimeVersion ?? '',
    artifact.compatibility.hermesVersion ?? '',
    nativeCapabilityKey,
  ].join(':');
}
