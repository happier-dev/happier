import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { PetPoseGrid } from '@/components/pets/render/PetPoseGrid';
import {
  BUILT_IN_PET_IDS,
  BUILT_IN_PET_PACKAGES,
} from '@/components/pets/builtIns/builtInPetRegistry';
import {
  projectStorePetCard,
  storePetArt,
  type StorePetCardView,
} from '@/components/store/catalog/storePets';
import {
  Directory,
  type DirectoryGroup,
  type DirectoryRow,
} from '@/components/store/StoreKindPage';
import {
  StorePetListing,
  type StorePetListingState,
} from '@/components/store/StorePetListing';
import {
  STORE_PET_CARD_MIN_WIDTH,
  STORE_PET_CARD_MIN_WIDTH_PHONE,
  useStorePetCardAnatomy,
} from '@/components/store/storePetCardAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui';

/**
 * Dev-only: Store › Pets (lab r12-store-A), a pet listing (r12-pet-L) and its Add outcomes (r12-pet-S), mounted from the
 * real directory, card anatomy, listing and pose grid at fixture props. `?scene=store|listing|states`. Registry sheets
 * are the lab's 2026-11-17 snapshot, served by the design-lab host; nothing here is a production path.
 */
export function PetStoreSpecimen(props: Readonly<{ scene: string }>) {
  if (props.scene === 'listing') return <ListingScene />;
  if (props.scene === 'states') return <StatesScene />;
  return <StoreScene />;
}

const LAB = 'http://100.64.35.88:8471/living-bots/r12/registry';
type Fixture = Readonly<{
  id: string;
  name: string;
  author: string;
  source: 'codex' | 'dex';
  v: 1 | 2;
  desc: string;
  file: string;
}>;
const FIXTURES: readonly Fixture[] = [
  {
    id: 'white-cat',
    name: 'Winter (겨울) the White Cat',
    author: 'KOOKOO',
    source: 'codex',
    v: 1,
    file: 'codex-pets/white-cat.webp',
    desc: 'Meet Winter, my white cat! I wanted to see Winter every time I opened my laptop, so I made this little desktop pet.',
  },
  {
    id: 'yuki-ginger-cat',
    name: '貓咪',
    author: 'vickiyuki',
    source: 'codex',
    v: 2,
    file: 'codex-pets/yuki-ginger-cat.webp',
    desc: 'A gentle ginger tabby companion with a cream muzzle and belly, warm brown eyes, and a ringed tail.',
  },
  {
    id: 'calico-cat-pico',
    name: 'PICO',
    author: 'jasper',
    source: 'codex',
    v: 1,
    file: 'codex-pets/calico-cat-pico.webp',
    desc: 'PICO in da house',
  },
  {
    id: 'yuki-tawny-owl',
    name: '貓頭鷹',
    author: 'vickiyuki',
    source: 'codex',
    v: 2,
    file: 'codex-pets/yuki-tawny-owl.webp',
    desc: 'A gentle tawny-and-cream owl companion with warm watercolor feathers, bright brown eyes, and small orange feet.',
  },
  {
    id: 'mochi-cat',
    name: 'Mochi',
    author: 'sizzlebop',
    source: 'codex',
    v: 1,
    file: 'codex-pets/mochi-cat.webp',
    desc: 'A sweet cream-colored kitten with round black eyes, pink inner ears, and a softly curled tail.',
  },
  {
    id: 'boba',
    name: 'Boba',
    author: 'railly',
    source: 'dex',
    v: 2,
    file: 'petdex/boba.webp',
    desc: 'A tiny otter sipping bubble tea while keeping you company in Codex.',
  },
  {
    id: 'apogee-penguin',
    name: 'Apogee Penguin',
    author: 'franklqx',
    source: 'dex',
    v: 2,
    file: 'petdex/apogee-penguin.webp',
    desc: 'A deadpan charcoal penguin with a warm-cream belly and tiny orange feet.',
  },
  {
    id: 'cinder',
    name: 'Cinder',
    author: 'irinso',
    source: 'dex',
    v: 1,
    file: 'petdex/cinder.webp',
    desc: 'A tiny orange pixel dog with droopy ears, a small hat, and calm coffee-in-chaos energy.',
  },
  {
    id: 'acorn',
    name: 'Acorn',
    author: 'verbal72',
    source: 'dex',
    v: 2,
    file: 'petdex/acorn.webp',
    desc: 'An oak nut with a cap hat. Plants the next task and hides when the build leaks.',
  },
  {
    id: 'bagel',
    name: 'Bagel',
    author: 'Suning D.',
    source: 'dex',
    v: 2,
    file: 'petdex/bagel.webp',
    desc: 'This is Bagel, my real-life little tabby kitten. I turned her actual photos into this tiny desktop pet, so she can keep us company on screen too.',
  },
];
const SOURCE = {
  codex: { id: 'builtin:codex-pets', title: 'codex-pets.net', total: 3704 },
  dex: { id: 'builtin:petdex', title: 'petdex.dev', total: 5208 },
} as const;

function summary(fixture: Fixture): RegistryCatalogItemSummary {
  return {
    kind: 'pet',
    sourceId: SOURCE[fixture.source].id,
    itemId: fixture.id,
    title: fixture.name,
    description: fixture.desc,
    publisher: { name: fixture.author },
    petMetadata: {
      spritesheetUrl: `${LAB}/${fixture.file}`,
      spriteVersionNumber: fixture.v,
      reportUrl: 'https://petdex.dev/legal/takedown',
      termsUrl: 'https://petdex.dev/legal/takedown',
    },
  };
}

type Row = DirectoryRow & Readonly<{ card: StorePetCardView }>;
const noop = () => {};

function StoreScene() {
  const phone = useDeviceType() === 'phone';
  const [query, setQuery] = React.useState('');
  const cardAnatomy = useStorePetCardAnatomy();
  const anatomy = React.useMemo<CollectionAnatomy<Row>>(
    () => ({
      glyph: (row) => cardAnatomy.glyph(row.card),
      title: (row) => cardAnatomy.title(row.card),
      where: (row) => cardAnatomy.where?.(row.card),
      reason: (row) => cardAnatomy.reason?.(row.card),
      preview: (row) => cardAnatomy.preview?.(row.card),
      accessibilityLabel: (row) => row.title,
      testID: (row) => cardAnatomy.testID?.(row.card) ?? row.key,
      columnTitles: cardAnatomy.columnTitles,
    }),
    [cardAnatomy],
  );
  const rows = React.useMemo(
    (): Row[] =>
      [
        ...BUILT_IN_PET_IDS.slice(0, 4).map((id): Row => ({
          key: `pet|builtIn|${id}`,
          title: BUILT_IN_PET_PACKAGES[id].manifest.displayName,
          description: null,
          mark: null,
          group: 'builtIn',
          open: noop,
          addable: false,
          card: projectStorePetCard(
            { kind: 'builtInPet', pet: BUILT_IN_PET_PACKAGES[id] },
            '',
            false,
          ),
        })),
        ...(['codex', 'dex'] as const).flatMap((source) =>
          FIXTURES.filter((item) => item.source === source)
            .slice(0, 4)
            .map((fixture, index): Row => ({
              key: `pet|${SOURCE[source].id}|${fixture.id}`,
              title: fixture.name,
              description: fixture.desc,
              mark: null,
              group: `source:${SOURCE[source].id}`,
              open: noop,
              card: projectStorePetCard(
                summary(fixture),
                SOURCE[source].title,
                source === 'codex' && index === 0,
              ),
            })),
        ),
      ].filter((row) =>
        row.title
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    [query],
  );
  const groups = React.useMemo(
    (): DirectoryGroup[] => [
      {
        key: 'builtIn',
        title: t('capabilities.store.builtIn'),
        description: t('settingsPets.store.builtInDescription'),
      },
      {
        key: `source:${SOURCE.codex.id}`,
        title: t('capabilities.store.fromSource', {
          source: SOURCE.codex.title,
        }),
      },
      {
        key: `source:${SOURCE.dex.id}`,
        title: t('capabilities.store.fromSource', { source: SOURCE.dex.title }),
      },
    ],
    [],
  );
  const groupAction = React.useCallback(
    (key: string) => ({
      kind: 'link' as const,
      onPress: noop,
      label: t('capabilities.store.search.allOf', {
        count:
          key === 'builtIn'
            ? BUILT_IN_PET_IDS.length
            : key.endsWith('codex-pets')
              ? SOURCE.codex.total
              : SOURCE.dex.total,
      }),
    }),
    [],
  );
  const create = (
    <RoundButton
      size="small"
      display="secondary"
      title={t('settingsPets.store.create')}
      onPress={noop}
    />
  );
  const catalog = (
    <SelectionListFilterChip
      filter={{
        id: 'store-catalog',
        label: t('capabilities.store.catalogLabel'),
        options: [
          { id: 'all', label: t('capabilities.store.allCatalogs') },
          { id: SOURCE.codex.id, label: SOURCE.codex.title },
          { id: SOURCE.dex.id, label: SOURCE.dex.title },
        ],
        selectedId: 'all',
        onChange: noop,
      }}
    />
  );
  return (
    <ItemList pageColumn="wide" testID="pets.specimen.store">
      <PageContentColumn>
        <MainScreenHeader
          title={t('settingsPets.title')}
          description={t('settingsPets.store.description')}
          {...(phone ? {} : { actions: create })}
          search={{
            value: query,
            onChangeText: setQuery,
            placeholder: t('settingsPets.store.search'),
            testID: 'pets.specimen.store.search',
          }}
          band={
            <View style={styles.band}>
              {catalog}
              {phone ? create : null}
            </View>
          }
        />
        <Directory<Row>
          kind="pet"
          rows={rows}
          groups={groups}
          list={{ loading: false, hasNextPage: false }}
          query={query}
          sourceTitle={(id) =>
            id === SOURCE.codex.id ? SOURCE.codex.title : SOURCE.dex.title
          }
          anatomy={anatomy}
          presentation="grid"
          groupAction={groupAction}
          minCardWidth={
            phone ? STORE_PET_CARD_MIN_WIDTH_PHONE : STORE_PET_CARD_MIN_WIDTH
          }
        />
      </PageContentColumn>
    </ItemList>
  );
}

const BOBA = FIXTURES.find((item) => item.id === 'boba')!;
const BOBA_WEAR = { kind: 'accountPet', accountPetId: 'specimen-boba', displayName: 'Boba' } as const;

function BobaListing(props: Readonly<{ state: StorePetListingState }>) {
  const item = summary(BOBA);
  return (
    <StorePetListing
      name={BOBA.name}
      meta={`${BOBA.author} · ${SOURCE.dex.title}`}
      description={BOBA.desc}
      sourceTitle={SOURCE.dex.title}
      art={storePetArt(item)}
      state={props.state}
      reportUrl="https://petdex.dev/legal/takedown"
      facts={[
        {
          key: 'licence',
          value: t('settingsPets.store.notStated'),
          note: t('settingsPets.store.terms', { source: SOURCE.dex.title }),
        },
        { key: 'published', value: '2 May 2026' },
      ]}
      onAdd={noop}
      wearPet={BOBA_WEAR}
      onUndo={noop}
      onMakeCompanion={noop}
      onOpenSettingsPets={noop}
      onOpenFeatures={noop}
      testID="pets.specimen.listing"
    />
  );
}

function ListingScene() {
  const phone = useDeviceType() === 'phone';
  return (
    <View style={phone ? styles.fill : styles.pane}>
      <BobaListing state={{ kind: 'available' }} />
    </View>
  );
}

const STATES: readonly Readonly<{
  label: string;
  state: StorePetListingState;
}>[] = [
  { label: 'Adding', state: { kind: 'adding' } },
  { label: 'Added', state: { kind: 'added' } },
  { label: 'Added just now, with Undo', state: { kind: 'addedNow', undo: 'ready' } },
  { label: "Undo couldn't remove it", state: { kind: 'addedNow', undo: 'failed' } },
  { label: 'Undone', state: { kind: 'removed' } },
  { label: "Couldn't add: the sheet fails the pet check", state: { kind: 'couldntAdd', reason: 'sheetCheck' } },
  { label: "Couldn't add: any other refusal", state: { kind: 'couldntAdd', reason: 'other' } },
  { label: 'Library full', state: { kind: 'libraryFull', limit: 20 } },
  { label: 'Pet sync off', state: { kind: 'syncOff' } },
];

function StatesScene() {
  const item = summary(BOBA);
  const art = storePetArt(item)!;
  return (
    <ScrollView contentContainerStyle={styles.states}>
      {STATES.map((entry) => (
        <View key={entry.label} style={styles.stateCell}>
          <Text variant="meta" emphasis="semiBold">
            {entry.label}
          </Text>
          <View style={styles.statePane}>
            <BobaListing state={entry.state} />
          </View>
        </View>
      ))}
      <View style={styles.stateCell}>
        <Text variant="meta" emphasis="semiBold">
          Pose grid at 56
        </Text>
        <PetPoseGrid
          spritesheetSource={art.spritesheetSource}
          opaqueBounds={null}
          size={56}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  band: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    alignItems: 'center',
  },
  fill: { flex: 1, backgroundColor: theme.colors.surface.base },
  pane: {
    width: 420,
    flex: 1,
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.surface.base,
  },
  states: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s24,
    padding: theme.space.s24,
  },
  stateCell: { width: 440, gap: theme.space.s8 },
  statePane: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.base,
    overflow: 'hidden',
  },
}));
