import type { DiscoveredPetPackageV1 } from '@happier-dev/protocol/pets/daemonRpc';
import type { DiscoveredPetPackage } from '../discovery/discoverCodexPets';

function originLabelForSource(source: DiscoveredPetPackage['source']): string {
  if (source.kind === 'happierManagedLocal') return 'This device';
  if ('homeKind' in source && source.homeKind === 'connectedService') return 'Connected Codex home';
  return 'Codex home';
}

export function toDiscoveredPetPackageDto(entry: DiscoveredPetPackage): DiscoveredPetPackageV1 {
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
