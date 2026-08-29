import {
  PluginAvailabilityPortableReleaseSourceClassV1Schema,
  normalizePluginAccountCollectionContractsV1,
  normalizePluginReleaseFactsV1,
  type PluginAvailabilityPortableReleaseSourceClassV1,
  type PackageAssetArchiveDescriptorV1,
} from '@happier-dev/protocol';
import type { PluginUiArtifactsManifestV1 } from '@happier-dev/protocol/plugins/ui';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import {
  PluginInstallationAvailabilityProjectionSchema,
  type PluginInstallationAvailabilityProjection,
} from '@/plugins/store/registry/generationStore';

export function resolvePluginUiArtifactAvailabilityPlatform(
  artifact: PluginUiArtifactsManifestV1['entries'][number],
): 'web' | 'ios' | 'android' {
  if (artifact.tier === 'hostedWeb') return 'web';
  if (
    artifact.platform === 'web'
    || artifact.platform === 'ios'
    || artifact.platform === 'android'
  ) return artifact.platform;
  throw new Error('React Native Availability artifacts require web, iOS, or Android platform identity');
}

/**
 * Projects only facts the existing verified acquisition and canonical manifest
 * owners have already produced. Generated UI artifact manifests carry the
 * portable build compatibility for immutable release slots; current host
 * app/channel/capability compatibility remains a transient Artifact-link fact.
 */
export function createVerifiedPortablePluginInstallationAvailability(input: Readonly<{
  sourceClass: PluginAvailabilityPortableReleaseSourceClassV1;
  archiveDigestSha256: `sha256:${string}`;
  manifest: CanonicalPluginManifest;
  /** The canonical generated graph that staging already verified for this archive. */
  generatedUiArtifacts: PluginUiArtifactsManifestV1;
  /** The only package asset descriptor staging verified from the exact candidate bytes. */
  packageAssetArchive: PackageAssetArchiveDescriptorV1;
}>): PluginInstallationAvailabilityProjection {
  const sourceClass = PluginAvailabilityPortableReleaseSourceClassV1Schema.parse(
    input.sourceClass,
  );
  const collectionContracts = normalizePluginAccountCollectionContractsV1({
    pluginId: input.manifest.id,
    contributions: input.manifest.contributes.accountCollections,
  }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({
    pluginId,
    collectionId,
    schemaVersion,
    contractDigest,
  }));
  const release = normalizePluginReleaseFactsV1({
    ref: {
      pluginId: input.manifest.id,
      version: input.manifest.version,
    },
    archiveDigestSha256: input.archiveDigestSha256,
    normalizedManifest: input.manifest,
    collectionContracts,
    uiSlots: input.generatedUiArtifacts.entries.map((artifact) => ({
      contributionId: artifact.contributionId,
      tier: artifact.tier,
      platform: resolvePluginUiArtifactAvailabilityPlatform(artifact),
      artifactDigest: artifact.digest,
      compatibility: {
        hostUiApiVersion: artifact.hostUiApiVersion,
        ...(artifact.tier === 'reactNative' && artifact.compat.react
          ? { reactVersion: artifact.compat.react }
          : {}),
        ...(artifact.compat.reactNative
          ? { reactNativeVersion: artifact.compat.reactNative }
          : {}),
        ...(artifact.compat.expoRuntime
          ? { expoRuntimeVersion: artifact.compat.expoRuntime }
          : {}),
        ...(artifact.compat.hermes
          ? { hermesVersion: artifact.compat.hermes }
          : {}),
      },
    })),
    packageAssetArchive: input.packageAssetArchive,
  });
  return PluginInstallationAvailabilityProjectionSchema.parse({
    sourceClass,
    portableRelease: true,
    release,
  });
}
