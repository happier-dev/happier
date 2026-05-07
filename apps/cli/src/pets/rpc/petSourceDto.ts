import {
  type DiscoveredPetPackageV1,
  type ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';

import type { PetPackageDiscoveryCacheEntry } from '../discovery/petPackageDiscoveryCache';

function originLabelForSource(source: PetPackageDiscoveryCacheEntry['source']): string {
  if (source.kind === 'happierManagedLocal') return 'This device';
  if (source.homeKind === 'connectedService') return 'Connected Codex home';
  return 'Codex home';
}

export function toDiscoveredPetPackageDto(entry: PetPackageDiscoveryCacheEntry): DiscoveredPetPackageV1 {
  return {
    sourceKey: entry.sourceKey,
    kind: entry.source.kind,
    petId: entry.petId,
    displayName: entry.displayName,
    description: entry.manifest.description,
    originLabel: originLabelForSource(entry.source),
    packageFormat: entry.packageFormat,
    manifest: entry.manifest,
    previewHandle: {
      kind: 'daemonSourceKey',
      sourceKey: entry.sourceKey,
    },
    mediaType: entry.mediaType,
    ...(entry.digest ? { digest: entry.digest } : {}),
    ...(typeof entry.sizeBytes === 'number' ? { sizeBytes: entry.sizeBytes } : {}),
  };
}

export function toImportedLocalPetPackageDto(entry: Readonly<{
  sourceKey: string;
  petId: string;
  displayName: string;
  description: string;
  digest: string;
  sizeBytes: number;
  mediaType: ImportedLocalPetPackageV1['mediaType'];
  manifest: ImportedLocalPetPackageV1['manifest'];
}>): ImportedLocalPetPackageV1 {
  return {
    sourceKey: entry.sourceKey,
    kind: 'happierManagedLocal',
    petId: entry.petId,
    displayName: entry.displayName,
    description: entry.description,
    originLabel: 'This device',
    digest: entry.digest,
    sizeBytes: entry.sizeBytes,
    mediaType: entry.mediaType,
    previewHandle: {
      kind: 'daemonSourceKey',
      sourceKey: entry.sourceKey,
    },
    manifest: entry.manifest,
  };
}
