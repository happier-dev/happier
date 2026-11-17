import { describe, expect, it } from 'vitest';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import {
  collectAddedRegistryPets,
  accountPetRegistryKey,
  projectStorePetCard,
  storeBuiltInPets,
} from './storePets';

const boba: RegistryCatalogItemSummary = {
  kind: 'pet',
  sourceId: 'builtin:petdex',
  itemId: 'boba',
  title: 'Boba',
  description: 'A tiny otter sipping bubble tea.',
  publisher: { name: 'railly' },
  petMetadata: {
    spritesheetUrl: 'https://petdex.dev/pets/boba/spritesheet.webp',
    reportUrl: 'https://petdex.dev/legal/takedown',
    termsUrl: 'https://petdex.dev/legal/takedown',
  },
};

function accountPet(
  id: string,
  origin: AccountPetLibraryEntryV1['origin'],
): AccountPetLibraryEntryV1 {
  return {
    accountPetId: id,
    packageFormat: 'codex-compatible-atlas-v1',
    origin,
    digest: 'sha256:x',
    sizeBytes: 1,
    createdAt: 0,
    updatedAt: 0,
    manifest: { id, displayName: id, description: id, spritesheetPath: 'spritesheet.webp' },
    spritesheetAssetRef: {
      assetId: id,
      mediaType: 'image/webp',
      digest: 'sha256:x',
      sizeBytes: 1,
    },
  } as AccountPetLibraryEntryV1;
}

describe('Store › Pets catalog', () => {
  it('marks a registry pet the Account holds as "In your pets" by its source and item ids only', () => {
    const added = collectAddedRegistryPets({
      a: accountPet('a', {
        kind: 'registry',
        sourceId: 'builtin:petdex',
        itemId: 'boba',
      }),
      b: accountPet('b', { kind: 'manualImport' }),
    });
    expect([...added.keys()]).toEqual([
      accountPetRegistryKey('builtin:petdex', 'boba'),
    ]);
    const card = projectStorePetCard(
      boba,
      'petdex.dev',
      added.has(accountPetRegistryKey(boba.sourceId, boba.itemId)),
    );
    expect(card).toMatchObject({
      key: 'pet|builtin:petdex|boba',
      byline: 'railly · petdex.dev',
      added: true,
    });
    expect(projectStorePetCard(boba, 'petdex.dev', false)).toMatchObject({
      added: false,
      summary: boba.description,
    });
  });

  it('lists every built-in pet for an empty query and narrows them by name', () => {
    expect(storeBuiltInPets('').length).toBeGreaterThan(1);
    expect(storeBuiltInPets('BLI').map((item) => item.pet.id)).toEqual([
      'blink',
    ]);
  });

});
