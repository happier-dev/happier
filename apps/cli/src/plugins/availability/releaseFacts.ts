import { PluginAvailabilityPortableReleaseSourceClassV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { normalizePluginAccountCollectionContractsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { PluginAvailabilityPortableReleaseSourceClassV1, PackageAssetArchiveDescriptorV1 } from '@happier-dev/protocol';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import {
  PluginInstallationAvailabilityProjectionSchema,
  type PluginInstallationAvailabilityProjection,
} from '@/plugins/store/registry/generationStore';

const ALL_EXECUTABLE_UI_PLATFORMS = Object.freeze(['web', 'ios', 'android'] as const);

export function projectVerifiedPluginUiReleaseSlotsV2(input: Readonly<{
  manifest: CanonicalPluginManifest;
  generatedUiArtifacts: PluginUiArtifactsManifestV2;
}>) {
  const entriesByArtifactId = new Map(input.generatedUiArtifacts.entries.map((entry) => [entry.artifactId, entry]));
  const declarations: Array<Readonly<{
    contributionId: string;
    artifactId: string;
    platforms: readonly ('web' | 'ios' | 'android')[];
  }>> = [];
  for (const renderer of input.manifest.contributes.ui.renderers) {
    if (renderer.kind === 'reactNative') {
      declarations.push({ contributionId: renderer.id, artifactId: renderer.artifact, platforms: ALL_EXECUTABLE_UI_PLATFORMS });
    } else if (renderer.kind === 'hostedWeb' && renderer.source.kind === 'artifact') {
      declarations.push({ contributionId: renderer.id, artifactId: renderer.source.artifact, platforms: ['web'] });
    }
  }
  for (const provider of input.manifest.contributes.voiceProviders) {
    if (provider.kind === 'conversation') {
      declarations.push({ contributionId: provider.id, artifactId: provider.client.artifactId, platforms: provider.platforms });
    }
  }
  for (const action of input.manifest.contributes.actions) {
    if (action.execution.target === 'client') {
      declarations.push({ contributionId: action.id, artifactId: action.execution.client.artifactId, platforms: action.execution.platforms });
    }
  }
  return declarations.flatMap((declaration) => {
    const artifact = entriesByArtifactId.get(declaration.artifactId);
    if (!artifact) throw new Error(`Generated UI artifact is missing for declaration: ${declaration.artifactId}`);
    return declaration.platforms.map((platform) => ({
      contributionId: declaration.contributionId,
      artifactId: artifact.artifactId,
      tier: artifact.tier,
      platform,
      artifactDigest: artifact.digest,
      hostUiApiRange: artifact.hostUiApiRange,
    }));
  });
}

/**
 * Projects only facts the existing verified acquisition and canonical manifest
 * owners have already produced. Generated UI artifact manifests carry the
 * portable Host UI API range for immutable release slots; current host
 * app/channel/capability metadata is not release or Artifact-link identity.
 */
export function createVerifiedPortablePluginInstallationAvailability(input: Readonly<{
  sourceClass: PluginAvailabilityPortableReleaseSourceClassV1;
  archiveDigestSha256: `sha256:${string}`;
  manifest: CanonicalPluginManifest;
  /** The canonical generated graph that staging already verified for this archive. */
  generatedUiArtifacts: PluginUiArtifactsManifestV2;
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
    uiSlots: projectVerifiedPluginUiReleaseSlotsV2({
      manifest: input.manifest,
      generatedUiArtifacts: input.generatedUiArtifacts,
    }),
    packageAssetArchive: input.packageAssetArchive,
  });
  return PluginInstallationAvailabilityProjectionSchema.parse({
    sourceClass,
    portableRelease: true,
    release,
  });
}
