import * as React from 'react';
import type { Href } from 'expo-router';
import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol/pets/constants';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  resolveBuiltInPetPackage,
  type BuiltInPetId,
} from '@/components/pets/builtIns/builtInPetRegistry';
import { usePetImport, type PetImportResult } from '@/components/pets/source/usePetImport';
import { usePetSelectionAction } from '@/components/pets/source/usePetSelectionAction';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { BUILT_IN_PET_SUBTITLE_KEYS } from '@/components/settings/pets/devicePetSelector/constants';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
  SurfaceStateCard,
  type SurfaceStateSize,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useRegistrySourceDescriptor } from '@/registries/useRegistrySourceRevision';
import { storage, usePeripheralFeedDemand } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatCalendarDate } from '@/utils/datetime/cachedIntlFormatters';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  accountPetRegistryKey,
  collectAddedRegistryPets,
  storePetArt,
} from './catalog/storePets';
import {
  StorePetListing,
  type StorePetListingFact,
  type StorePetListingState,
} from './StorePetListing';

export type StorePetListingReference =
  | Readonly<{
      kind: 'registry';
      sourceId: string;
      itemId: string;
      version?: string;
    }>
  | Readonly<{ kind: 'builtIn'; petId: BuiltInPetId }>;

/** The opened pet: a built-in from the app, or a registry pet read once through the registry owner. */
export function StorePetListingController(
  props: Readonly<{
    reference: StorePetListingReference;
    size: SurfaceStateSize;
  }>,
) {
  return props.reference.kind === 'builtIn' ? (
    <BuiltInPetListing petId={props.reference.petId} />
  ) : (
    <RegistryPetListing {...props.reference} size={props.size} />
  );
}

function useOpenSettings() {
  const router = useRouter();
  return React.useMemo(
    () => ({
      pets: () => router.push(SETTINGS_ROUTES.pets as Href),
      features: () => router.push(SETTINGS_ROUTES.features as Href),
    }),
    [router],
  );
}

function BuiltInPetListing(props: Readonly<{ petId: BuiltInPetId }>) {
  const pet = resolveBuiltInPetPackage(props.petId);
  const selectPet = usePetSelectionAction();
  const open = useOpenSettings();
  const art = React.useMemo(
    () => storePetArt({ kind: 'builtInPet', pet }),
    [pet],
  );
  return (
    <StorePetListing
      testID="store.pet.listing"
      name={pet.manifest.displayName}
      meta={t('settingsPets.store.builtInByline')}
      description={t(BUILT_IN_PET_SUBTITLE_KEYS[props.petId])}
      sourceTitle="Happier"
      art={art}
      state={BUILT_IN_STATE}
      facts={NO_FACTS}
      reportUrl={null}
      onAdd={noop}
      onOpenSettingsPets={open.pets}
      onOpenFeatures={open.features}
      onMakeCompanion={() =>
        fireAndForget(
          selectPet({ petRef: { kind: 'builtIn', petId: props.petId } }),
          { tag: 'StorePetListing.companion' },
        )
      }
    />
  );
}

const BUILT_IN_STATE: StorePetListingState = { kind: 'builtIn' };
const NO_FACTS: readonly StorePetListingFact[] = [];
const noop = () => {};

function RegistryPetListing(
  props: Readonly<{
    sourceId: string;
    itemId: string;
    version?: string;
    size: SurfaceStateSize;
  }>,
) {
  const presented = useLayoutPresentationActive();
  const syncEnabled = useFeatureEnabled('pets.sync');
  usePeripheralFeedDemand('accountPets', presented && syncEnabled);
  const read = useRegistryItem(
    {
      kind: 'pet',
      sourceId: props.sourceId,
      itemId: props.itemId,
      ...(props.version ? { version: props.version } : {}),
    },
    presented,
  );
  const sourceTitle = useRegistrySourceDescriptor(props.sourceId, presented)?.title ?? t('capabilities.store.unnamedCatalog');
  const accountPetsById = storage((state) => state.accountPetsById);
  const held = React.useMemo(
    () =>
      collectAddedRegistryPets(accountPetsById).get(
        accountPetRegistryKey(props.sourceId, props.itemId),
      ) ?? null,
    [accountPetsById, props.sourceId, props.itemId],
  );
  const importPet = usePetImport();
  const selectPet = usePetSelectionAction();
  const open = useOpenSettings();
  const [adding, setAdding] = React.useState(false);
  const [outcome, setOutcome] = React.useState<StorePetListingState | null>(null);
  const summary = read.item?.summary ?? null;
  const pet = read.item?.payload.kind === 'pet' ? read.item.payload.pet : null;

  const onAdd = React.useCallback(() => {
    setAdding(true);
    setOutcome(null);
    fireAndForget(
      (async () => {
        try {
          // The pet-import owner names the outcome; the listing only says it (one Action, one set of outcomes).
          setOutcome(listingStateOfImport(await importPet({ source: { kind: 'registry', sourceId: props.sourceId, itemId: props.itemId } })));
        } finally {
          setAdding(false);
        }
      })(),
      { tag: 'StorePetListing.add' },
    );
  }, [importPet, props.sourceId, props.itemId]);

  if (!summary) {
    return read.loading || !read.error ? (
      <SurfaceStateCard
        kind="loading"
        size={props.size}
        testID="store.pet.listing.loading"
        title={t('common.loading')}
      />
    ) : (
      <SurfaceStateCard
        kind="error"
        size={props.size}
        testID="store.pet.listing.failed"
        title={t('capabilities.store.listing.failed')}
        diagnosticCode={read.status?.state ?? null}
        action={{ label: t('capabilities.store.retry'), onPress: read.refresh }}
      />
    );
  }
  const state: StorePetListingState = held
    ? { kind: 'added' }
    : !syncEnabled
      ? { kind: 'syncOff' }
      : adding
        ? { kind: 'adding' }
        : outcome ?? { kind: 'available' };
  // "Looks around" is said by the listing from the sheet's decoded atlas, never from the registry's label.
  const facts: StorePetListingFact[] = [
    {
      key: 'licence',
      value: summary.license?.trim() || t('settingsPets.store.notStated'),
      note: t('settingsPets.store.terms', { source: sourceTitle }),
    },
    ...(summary.updatedAt
      ? [
          {
            key: 'published' as const,
            value: formatCalendarDate(summary.updatedAt),
          },
        ]
      : []),
  ];
  const registryArt = storePetArt(summary);
  // A held pet's atlas facts are the server's (decoded when it was added); before that the listing decodes the sheet.
  const art = registryArt && held ? { ...registryArt,
    ...(held.manifest.spriteVersionNumber ? { spriteVersionNumber: held.manifest.spriteVersionNumber } : {}),
    ...(held.hasNeutralLookCell === undefined ? {} : { hasNeutralLookCell: held.hasNeutralLookCell }) } : registryArt;
  return (
    <StorePetListing
      testID="store.pet.listing"
      name={summary.title}
      meta={
        summary.publisher
          ? `${summary.publisher.name} · ${sourceTitle}`
          : sourceTitle
      }
      description={summary.description?.trim() || null}
      sourceTitle={sourceTitle}
      art={art}
      state={state}
      facts={facts}
      reportUrl={pet?.reportUrl ?? summary.petMetadata?.reportUrl ?? null}
      onAdd={onAdd}
      onOpenSettingsPets={open.pets}
      onOpenFeatures={open.features}
      {...(held
        ? {
            onMakeCompanion: () =>
              fireAndForget(
                selectPet({
                  petRef: {
                    kind: 'accountPet',
                    accountPetId: held.accountPetId,
                  },
                }),
                { tag: 'StorePetListing.companion' },
              ),
          }
        : {})}
    />
  );
}

/** A failed import as the listing says it; an added pet is shown from the Account library, not from this state. */
function listingStateOfImport(outcome: PetImportResult): StorePetListingState | null {
  switch (outcome.kind) {
    case 'added': return null;
    case 'library_full': return { kind: 'libraryFull', limit: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount };
    case 'pet_sync_off': return { kind: 'syncOff' };
    case 'could_not_add': return { kind: 'couldntAdd' };
    case 'unreachable': return { kind: 'unreachable' };
  }
}
