import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';

type PetPackageDiscoveryCacheEntry = NonNullable<ReturnType<PetPackageDiscoveryCache['get']>>;

export type DiscoveredPetPackageDto = Readonly<{
  sourceKey: string;
  kind: PetPackageDiscoveryCacheEntry['source']['kind'];
  petId: string;
  displayName: string;
  description: string;
  originLabel: string;
  packageFormat: PetPackageDiscoveryCacheEntry['packageFormat'];
  manifest: PetPackageDiscoveryCacheEntry['manifest'];
  previewHandle: Readonly<{
    kind: 'daemonSourceKey';
    sourceKey: string;
  }>;
  mediaType: PetPackageDiscoveryCacheEntry['mediaType'];
  digest?: string;
  sizeBytes?: number;
}>;

function originLabelForSource(source: PetPackageDiscoveryCacheEntry['source']): string {
  if (source.kind === 'happierManagedLocal') return 'This device';
  if ('homeKind' in source && source.homeKind === 'connectedService') return 'Connected Codex home';
  return 'Codex home';
}

export function toDiscoveredPetPackageDto(entry: PetPackageDiscoveryCacheEntry): DiscoveredPetPackageDto {
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
