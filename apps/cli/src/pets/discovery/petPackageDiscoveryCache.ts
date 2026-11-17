import type { DiscoveredPetPackageV1, PetPackageSourceV1 } from '@happier-dev/protocol';

/** Daemon-owned filesystem facts; only the redacted DTO crosses the RPC boundary. */
export type PetPackageDiscoveryCacheEntry = Pick<DiscoveredPetPackageV1,
  'sourceKey' | 'petId' | 'displayName' | 'packageFormat' | 'manifest' | 'mediaType' | 'digest' | 'sizeBytes'
> & Readonly<{
  source: Extract<PetPackageSourceV1, { kind: 'detectedCodexHome' | 'happierManagedLocal' }>;
  packagePath: string;
  spritesheetPath: string;
}>;

export type PetPackageDiscoveryCache = Readonly<{
  remember: (pets: readonly PetPackageDiscoveryCacheEntry[]) => void;
  get: (sourceKey: string) => PetPackageDiscoveryCacheEntry | null;
  forget: (sourceKey: string) => void;
}>;

export function createPetPackageDiscoveryCache(): PetPackageDiscoveryCache {
  const petsBySourceKey = new Map<string, PetPackageDiscoveryCacheEntry>();
  return {
    remember: (pets) => {
      for (const pet of pets) {
        petsBySourceKey.set(pet.sourceKey, pet);
      }
    },
    get: (sourceKey) => petsBySourceKey.get(sourceKey) ?? null,
    forget: (sourceKey) => {
      petsBySourceKey.delete(sourceKey);
    },
  };
}
