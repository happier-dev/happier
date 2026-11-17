import type { ImageProps } from 'expo-image';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import type { PetCellBoundsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import {
  BUILT_IN_PET_IDS,
  BUILT_IN_PET_PACKAGES,
  type BuiltInPetPackage,
} from '@/components/pets/builtIns/builtInPetRegistry';
import { BUILT_IN_PET_SUBTITLE_KEYS } from '@/components/settings/pets/devicePetSelector/constants';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { t } from '@/text';

/** A pet built into Happier: always in the person's pets, so its card opens the pet and has nothing to add. */
export type StoreBuiltInPetItem = Readonly<{
  kind: 'builtInPet';
  pet: BuiltInPetPackage;
}>;
export type StorePetItem = RegistryCatalogItemSummary | StoreBuiltInPetItem;

const BUILT_IN_ITEMS: readonly StoreBuiltInPetItem[] = BUILT_IN_PET_IDS.map(
  (id) => ({ kind: 'builtInPet', pet: BUILT_IN_PET_PACKAGES[id] }),
);

/** The built-ins a pet query matches, in their registry order. */
export function storeBuiltInPets(
  query: string,
): readonly StoreBuiltInPetItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? BUILT_IN_ITEMS.filter((item) =>
        item.pet.manifest.displayName.toLocaleLowerCase().includes(needle),
      )
    : BUILT_IN_ITEMS;
}

function builtInDescription(item: StoreBuiltInPetItem): string {
  return t(BUILT_IN_PET_SUBTITLE_KEYS[item.pet.id]);
}

export function storePetSummary(item: StorePetItem) {
  return item.kind === 'builtInPet'
    ? {
        key: JSON.stringify(['builtInPet', item.pet.id]),
        ref: item,
        title: item.pet.manifest.displayName,
        description: builtInDescription(item),
        mark: undefined,
      }
    : {
        key: JSON.stringify([item.kind, item.sourceId, item.itemId]),
        ref: item,
        title: item.title,
        description: item.description,
        mark: item.brandMark,
      };
}

/** The pet a card, a listing and the pose grid draw: one atlas, its opaque bounds when known, and its seed. */
export type StorePetArt = Readonly<{
  spritesheetSource: ImageProps['source'];
  /** Unknown for a registry sheet until it is added; the face then fits the whole cell, which never crops. */
  opaqueBounds: PetCellBoundsV1 | null;
  seed: number;
  /** The atlas version when an owner states it (a built-in's atlas, the server's for an Account pet); a registry sheet's
   * version comes from its decoded size (`usePetSheetSpriteVersion`), never from the registry's label. */
  spriteVersionNumber?: 1 | 2;
  /** The server's pixel check for a v2 sheet's look-at-you cell; unknown before it is added (idle frame 0 then). */
  hasNeutralLookCell?: boolean;
}>;

/** One browse card (lab r12-store-A): the pet at rest, its name, author · source, then one quiet line. */
export type StorePetCardView = Readonly<{
  key: string;
  name: string;
  byline: string;
  summary: string;
  /** "In your pets": a registry pet the Account already holds (decision 5). */
  added: boolean;
  art: StorePetArt | null;
}>;

/** Registry identity of an Account pet, the only origin fact "In your pets" needs (mechanism 5). */
export function accountPetRegistryKey(
  sourceId: string,
  itemId: string,
): string {
  return JSON.stringify([sourceId, itemId]);
}

export function collectAddedRegistryPets(
  pets: Readonly<Record<string, AccountPetLibraryEntryV1>>,
): ReadonlyMap<string, AccountPetLibraryEntryV1> {
  const added = new Map<string, AccountPetLibraryEntryV1>();
  for (const pet of Object.values(pets)) {
    if (pet.origin.kind === 'registry')
      added.set(
        accountPetRegistryKey(pet.origin.sourceId, pet.origin.itemId),
        pet,
      );
  }
  return added;
}

/** A stable per-pet seed so cards' idle gestures never step together. */
export function storePetSeed(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1)
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

export function storePetArt(item: StorePetItem): StorePetArt | null {
  if (item.kind === 'builtInPet')
    return {
      spritesheetSource: item.pet.spritesheetSource,
      opaqueBounds: item.pet.opaqueBounds,
      seed: storePetSeed(item.pet.id),
      spriteVersionNumber: 1,
    };
  const url = item.petMetadata?.spritesheetUrl;
  return url
    ? {
        spritesheetSource: { uri: url },
        opaqueBounds: null,
        seed: storePetSeed(`${item.sourceId}|${item.itemId}`),
      }
    : null;
}

export function projectStorePetCard(
  item: StorePetItem,
  sourceTitle: string,
  added: boolean,
): StorePetCardView {
  if (item.kind === 'builtInPet')
    return {
      key: `pet|builtIn|${item.pet.id}`,
      name: item.pet.manifest.displayName,
      byline: t('settingsPets.store.builtInByline'),
      summary: builtInDescription(item),
      added: false,
      art: storePetArt(item),
    };
  return {
    key: `pet|${item.sourceId}|${item.itemId}`,
    name: item.title,
    byline: item.publisher
      ? `${item.publisher.name} · ${sourceTitle}`
      : sourceTitle,
    summary: added
      ? t('settingsPets.store.inYourPets')
      : (item.description?.trim() ?? ''),
    added,
    art: storePetArt(item),
  };
}
