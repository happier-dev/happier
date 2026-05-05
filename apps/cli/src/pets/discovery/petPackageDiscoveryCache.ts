import type { DiscoveredPetPackageV1 } from '@happier-dev/protocol';

export type PetPackageDiscoveryCache = Readonly<{
  remember: (pets: readonly DiscoveredPetPackageV1[]) => void;
  get: (sourceKey: string) => DiscoveredPetPackageV1 | null;
  forget: (sourceKey: string) => void;
}>;

export function createPetPackageDiscoveryCache(): PetPackageDiscoveryCache {
  const petsBySourceKey = new Map<string, DiscoveredPetPackageV1>();
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
