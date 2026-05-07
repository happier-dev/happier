import type {
  PetAssetMediaTypeV1,
  PetPackageManifestV1,
  PetPackageSourceV1,
} from '@happier-dev/protocol';

import { PET_DISCOVERY_LIMITS_V1, PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from '@happier-dev/protocol';

export type PetPackageDiscoveryCacheEntry = Readonly<{
  sourceKey: string;
  petId: string;
  displayName: string;
  packageFormat: typeof PET_PACKAGE_FORMAT_CODEX_ATLAS_V1;
  manifest: PetPackageManifestV1;
  source: Extract<PetPackageSourceV1, { kind: 'detectedCodexHome' | 'happierManagedLocal' }>;
  packagePath: string;
  spritesheetPath: string;
  mediaType: PetAssetMediaTypeV1;
  digest?: string;
  sizeBytes?: number;
}>;

type PetPackageDiscoveryCacheOptions = Readonly<{
  ttlMs?: number;
  nowMs?: () => number;
}>;

type CacheRecord = Readonly<{
  pet: PetPackageDiscoveryCacheEntry;
  rememberedAtMs: number;
}>;

export type PetPackageDiscoveryCache = Readonly<{
  remember: (pets: readonly PetPackageDiscoveryCacheEntry[]) => void;
  get: (sourceKey: string) => PetPackageDiscoveryCacheEntry | null;
  forget: (sourceKey: string) => void;
  drop: () => void;
}>;

export function createPetPackageDiscoveryCache(options: PetPackageDiscoveryCacheOptions = {}): PetPackageDiscoveryCache {
  const petsBySourceKey = new Map<string, CacheRecord>();
  const ttlMs = options.ttlMs ?? PET_DISCOVERY_LIMITS_V1.discoveryCacheTtlMs;
  const nowMs = options.nowMs ?? Date.now;

  function isFresh(record: CacheRecord): boolean {
    return nowMs() - record.rememberedAtMs <= ttlMs;
  }

  return {
    remember: (pets) => {
      for (const pet of pets) {
        petsBySourceKey.set(pet.sourceKey, {
          pet,
          rememberedAtMs: nowMs(),
        });
      }
    },
    get: (sourceKey) => {
      const record = petsBySourceKey.get(sourceKey) ?? null;
      if (!record) return null;
      if (isFresh(record)) return record.pet;
      petsBySourceKey.delete(sourceKey);
      return null;
    },
    forget: (sourceKey) => {
      petsBySourceKey.delete(sourceKey);
    },
    drop: () => {
      petsBySourceKey.clear();
    },
  };
}
