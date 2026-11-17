import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Collection, useHappierCollection } from '@happier-dev/plugin-ui';

import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { ThemeDevicePickerView } from '@/components/settings/appearance/themeProfiles/ThemeDevicePickerView';
import type { ThemeDevicePickerRow } from '@/components/settings/appearance/themeProfiles/themeDevicePickerViewTypes';
import { ThemeTryBar } from '@/components/settings/appearance/themeProfiles/ThemeTryBar';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { StoreThemeListing } from '@/components/store/StoreThemeListing';
import { useStoreThemeCardAnatomy } from '@/components/store/storeThemeCardAnatomy';
import type {
  StoreThemeCardView,
  StoreThemeListingFace,
} from '@/components/store/storeThemeViewTypes';
import { ThemeActionResultView } from '@/components/tools/renderers/system/ThemeActionResultView';
import type {
  ThemeActionResultViewProps,
  ThemeResultPhase,
} from '@/components/tools/renderers/system/themeActionResultViewTypes';
import { RegistrySourcesUnavailable } from '@/components/capabilities/add/RegistrySourcesUnavailable';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';
import { t } from '@/text';
import type { ThemeMiniatureData } from '@/theme/profiles/themeProfileTypes';

/**
 * Dev-only: the Themes program's agent card, device picker and Store → Themes views at fixture props, so their
 * composition can be judged live beside the lab before the controllers land. `?scene=` picks one scene
 * (B1, B3, B4, E2, E4, failed, C1, C2, C2b, loading, empty, failed-source); the default shows the card scenes.
 * Fixture themes are neutral lab names; nothing here is a production path.
 */
export function ThemesSpecimen(props: Readonly<{ scene: string }>) {
  const source = useDemoMessages(NO_MESSAGES);
  if (
    props.scene.startsWith('C') ||
    ['loading', 'empty', 'failed-source'].includes(props.scene)
  ) {
    return <StoreScene scene={props.scene} />;
  }
  const scenes =
    props.scene === 'all'
      ? ['B1', 'B3', 'B4', 'E2', 'E4', 'failed']
      : [props.scene];
  return (
    <SessionTranscriptSourceProvider source={source}>
      <ScrollView contentContainerStyle={styles.transcriptScroll}>
        <View style={styles.transcript}>
          {scenes.map((scene) => (
            <CardScene key={scene} scene={scene} />
          ))}
        </View>
      </ScrollView>
    </SessionTranscriptSourceProvider>
  );
}

const NO_MESSAGES: never[] = [];

const mini = (
  m: Omit<ThemeMiniatureData, 'border'> &
    Partial<Pick<ThemeMiniatureData, 'border'>>,
): ThemeMiniatureData => ({
  border: m.mode === 'dark' ? 'rgba(255,235,210,0.12)' : 'rgba(60,40,20,0.12)',
  ...m,
});
const NOTEBOOK = mini({
  mode: 'light',
  canvas: '#EFE8DA',
  raised: '#FAF6EE',
  text: '#2A251E',
  mutedText: '#6E6557',
  accent: '#9C5A2E',
  radius: 'round',
});
const LINEN = mini({
  mode: 'light',
  canvas: '#ECEDE7',
  raised: '#F9F9F5',
  text: '#23261F',
  mutedText: '#62665B',
  accent: '#4F6B57',
  radius: 'soft',
});
const KRAFT = mini({
  mode: 'light',
  canvas: '#E3D5BD',
  raised: '#F1E7D4',
  text: '#2B2116',
  mutedText: '#6B5843',
  accent: '#7A4A22',
  radius: 'sharp',
});
const HAPPIER = mini({
  mode: 'light',
  canvas: '#F2F2F2',
  raised: '#FFFFFF',
  text: '#1C1C1E',
  mutedText: '#6C6C70',
  accent: '#1C1C1E',
  radius: 'soft',
});
const ATLAS = mini({
  mode: 'light',
  canvas: '#F1F2F6',
  raised: '#FFFFFF',
  text: '#171A2B',
  mutedText: '#5D627A',
  accent: '#4A57D6',
  radius: 'round',
});
const ATLAS_NIGHT = mini({
  mode: 'dark',
  canvas: '#0E1020',
  raised: '#151829',
  text: '#E3E5F2',
  mutedText: '#8E92AA',
  accent: '#8C96FF',
  radius: 'round',
});
const HARBOR = mini({
  mode: 'light',
  canvas: '#EAF0F4',
  raised: '#FBFCFD',
  text: '#14222D',
  mutedText: '#56687A',
  accent: '#2F6E9C',
  radius: 'soft',
});
const HARBOR_NIGHT = mini({
  mode: 'dark',
  canvas: '#0D141A',
  raised: '#131B23',
  text: '#DCE6EE',
  mutedText: '#8799A8',
  accent: '#5BA4D6',
  radius: 'soft',
});
const NOCTURNE = mini({
  mode: 'dark',
  canvas: '#0B0B12',
  raised: '#12121C',
  text: '#E3E2F2',
  mutedText: '#8E8CA8',
  accent: '#9C8CFF',
  radius: 'round',
});

const noop = () => {};

function CardScene(props: Readonly<{ scene: string }>) {
  const anchor = React.useRef<View>(null);
  const [phase, setPhase] = React.useState<ThemeResultPhase>(() =>
    initialPhase(props.scene),
  );
  const [option, setOption] = React.useState('linen');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [webOnly, setWebOnly] = React.useState<readonly string[] | null>(null);
  const picker = usePickerFixture(() => setPickerOpen(false));
  const base: ThemeActionResultViewProps = {
    theme: {
      name:
        props.scene === 'B3'
          ? option === 'kraft'
            ? 'Kraft'
            : option === 'notebook'
              ? 'Notebook'
              : 'Linen'
          : 'Notebook',
      mode: 'light',
      miniature:
        props.scene === 'B3'
          ? option === 'kraft'
            ? KRAFT
            : option === 'notebook'
              ? NOTEBOOK
              : LINEN
          : NOTEBOOK,
      created: props.scene !== 'B4',
    },
    phase,
    busy: null,
    here: 'this Mac',
    onKeep: () => setPhase({ kind: 'kept' }),
    onUndo: () =>
      setPhase(
        phase.kind === 'trying'
          ? { kind: 'reverted' }
          : { kind: 'undone', restoredName: 'Happier' },
      ),
    onRedo: () => setPhase({ kind: 'kept' }),
    onRetry: () => setPhase({ kind: 'trying' }),
    onTryOption: (key) => {
      setOption(key);
      setPhase({ kind: 'trying' });
    },
    onEdit: noop,
    onUseOtherDevices: () => setPickerOpen(true),
    onDismissDevices: () => setPickerOpen(false),
    devicesAnchorRef: anchor,
    devicePicker: pickerOpen ? <ThemeDevicePickerView {...picker} /> : null,
    testID: `themes.specimen.${props.scene}`,
  };
  const scene: ThemeActionResultViewProps =
    props.scene === 'B3'
      ? {
          ...base,
          options: [
            {
              key: 'notebook',
              name: 'Notebook',
              description: 'Cream page, warm ink, a rust accent, round corners',
              miniature: NOTEBOOK,
            },
            {
              key: 'linen',
              name: 'Linen',
              description:
                'Off-white with sage, soft corners, a quieter accent',
              miniature: LINEN,
            },
            {
              key: 'kraft',
              name: 'Kraft',
              description: 'Brown paper, dark ink, square corners',
              miniature: KRAFT,
            },
          ],
          currentOptionKey:
            phase.kind === 'trying' || phase.kind === 'kept' ? option : null,
        }
      : props.scene === 'B4'
        ? {
            ...base,
            before: HAPPIER,
            reshapes: ['session list', 'composer'],
            coverage: { total: 14, native: 11, webOnly: 3 },
            webOnlyRules: webOnly,
            onRevealWebOnly: () =>
              setWebOnly([
                'The dot before each session’s status',
                'Showing a session’s time on hover',
                'The composer’s blur',
              ]),
          }
        : props.scene === 'E2'
          ? {
              ...base,
              distribution: {
                applied: ['MacBook Pro', 'Office desktop', 'Phone'],
                failed: [],
              },
            }
          : props.scene === 'E4'
            ? {
                ...base,
                hides: ['sidebar'],
              }
            : base;
  return (
    <View style={styles.scene}>
      <Text variant="meta" style={styles.sceneLabel}>
        {props.scene}
      </Text>
      <ThemeActionResultView {...scene} devicesAnchorRef={anchor} />
    </View>
  );
}

function initialPhase(scene: string): ThemeResultPhase {
  switch (scene) {
    case 'E2':
    case 'E4':
      return { kind: 'kept' };
    case 'failed':
      return {
        kind: 'failed',
        operation: 'keep',
        code: 'theme_install_partial',
      };
    default:
      return { kind: 'trying' };
  }
}

function usePickerFixture(onDismiss: () => void) {
  const [rows, setRows] = React.useState<readonly ThemeDevicePickerRow[]>([
    {
      id: 'mac',
      label: 'MacBook Pro',
      computer: true,
      current: true,
      checked: true,
      outcome: null,
    },
    {
      id: 'office',
      label: 'Office desktop',
      computer: true,
      current: false,
      checked: true,
      outcome: null,
    },
    {
      id: 'phone',
      label: 'Phone',
      computer: false,
      current: false,
      checked: true,
      outcome: null,
    },
  ]);
  return {
    themeName: 'Notebook',
    mode: 'light' as const,
    state: 'ready' as const,
    rows,
    dispatching: false,
    onToggle: (id: string) =>
      setRows((current) =>
        current.map((row) =>
          row.id === id ? { ...row, checked: !row.checked } : row,
        ),
      ),
    onUse: () =>
      setRows((current) =>
        current.map((row) =>
          row.checked && !row.current ? { ...row, outcome: 'applied' } : row,
        ),
      ),
    onRetry: noop,
    onDismiss,
    testID: 'themes.specimen.picker',
  };
}

const CARDS: readonly StoreThemeCardView[] = [
  {
    key: 'atlas',
    name: 'Atlas',
    byline: 'mira.sato · Happier catalog',
    summary: 'Light and dark · Reshapes layout',
    faces: [ATLAS, ATLAS_NIGHT],
  },
  {
    key: 'harbor',
    name: 'Harbor',
    byline: 'tideline · Open VSX',
    summary: 'Light and dark · Colours only',
    faces: [HARBOR, HARBOR_NIGHT],
  },
  {
    key: 'nocturne',
    name: 'Nocturne',
    byline: 'Happier · Happier catalog',
    summary: 'Dark · Reshapes layout',
    faces: [NOCTURNE],
  },
  {
    key: 'fjord',
    name: 'Fjord',
    byline: 'kerrfield · Open VSX',
    summary: 'Dark · Colours only',
    faces: [],
  },
  {
    key: 'studio',
    name: 'Studio Mono',
    byline: 'Studio themes · Plugin',
    summary: 'Light and dark · Installed',
    faces: [HAPPIER, NOCTURNE],
  },
  {
    key: 'paper',
    name: 'Paper and Ink',
    byline: 'quill · Open VSX',
    summary: 'Light · Colours only',
    faces: [],
  },
];

const FACES: readonly StoreThemeListingFace[] = [
  { id: 'atlas-light', name: 'Atlas Light', mode: 'light', miniature: ATLAS },
  {
    id: 'atlas-night',
    name: 'Atlas Night',
    mode: 'dark',
    miniature: ATLAS_NIGHT,
  },
];

function StoreScene(props: Readonly<{ scene: string }>) {
  const [mode, setMode] = React.useState<'any' | 'light' | 'dark'>('any');
  const [query, setQuery] = React.useState(
    props.scene === 'empty' ? 'sepia' : '',
  );
  const [trying, setTrying] = React.useState<string | null>(
    props.scene === 'C1' ? null : 'atlas-light',
  );
  const [listingOpen, setListingOpen] = React.useState(props.scene === 'C2');
  const anatomy = useStoreThemeCardAnatomy();
  const cards =
    props.scene === 'empty'
      ? []
      : props.scene === 'failed-source'
        ? CARDS.filter((card) => !card.byline.includes('Open VSX'))
        : CARDS;
  const model = useHappierCollection<StoreThemeCardView>({ items: cards, keyOf: readCardKey, openKey: null, onOpenChange: (key) => { if (key) setListingOpen(true); } });
  return (
    <View style={styles.storeRoot}>
      <View style={styles.storePage}>
        <ItemList pageColumn="wide" testID="themes.specimen.store">
          <PageContentColumn>
            <MainScreenHeader
              title={t('themeStore.title')}
              description={t('themeStore.description')}
              search={{
                value: query,
                onChangeText: setQuery,
                placeholder: t('themeStore.search'),
                testID: 'themes.specimen.store.search',
              }}
              band={
                <SegmentedTabBar<'any' | 'light' | 'dark'>
                  role="radiogroup"
                  segmentSizing="content"
                  accessibilityLabel={t('themeStore.modeFilter')}
                  activeTabId={mode}
                  onSelectTab={setMode}
                  tabs={[
                    { id: 'any', label: t('themeStore.anyMode') },
                    { id: 'light', label: t('themeCard.light') },
                    { id: 'dark', label: t('themeCard.dark') },
                  ]}
                />
              }
            />
            {props.scene === 'failed-source' ? (
              <RegistrySourcesUnavailable
                testID="themes.specimen.store.failed"
                size="line"
                failures={[
                  {
                    key: 'open-vsx',
                    message:
                      'Open VSX didn’t answer. Showing the Happier catalog and your plugins.',
                    onRetry: noop,
                  },
                ]}
              />
            ) : null}
            {props.scene === 'empty' ? (
              <EmptyState
                layout="line"
                title={t('themeStore.noMatches', { query })}
              />
            ) : (
              <CoreCollectionScope renderPageScroller={passThrough}>
                <Collection<StoreThemeCardView>
                  testID="themes.specimen.store.cards"
                  model={model}
                  anatomy={anatomy}
                  accessibilityLabel={t('themeStore.title')}
                  presentation="grid"
                  detail="none"
                  scroll="page"
                  minListWidth={240}
                  minDetailWidth={240}
                  preferredListRatio={1}
                  minCardWidth={240}
                  loading={props.scene === 'loading'}
                />
              </CoreCollectionScope>
            )}
          </PageContentColumn>
        </ItemList>
        <ThemeTryBar
          visible={trying !== null && !listingOpen}
          faceName="Atlas Light"
          miniature={ATLAS}
          here="this Mac"
          busy={null}
          onRevert={() => setTrying(null)}
          onInstall={() => setTrying(null)}
          testID="themes.specimen.trybar"
        />
      </View>
      {listingOpen ? (
        <View style={styles.pane}>
          <ScrollView>
            <StoreThemeListing
              name="Atlas"
              kicker="Theme · Light and dark"
              meta="mira.sato · Happier catalog · 2.1.0 · Reviewed for the Happier catalog"
              description="An ink-blue workspace with rounder corners and a narrower sidebar, in light and dark."
              faces={FACES}
              facesState="ready"
              tryingFaceId={trying}
              preferredFaceId="atlas-light"
              here="this Mac"
              installed={false}
              facts={[
                { key: 'includes', value: 'Atlas Light, Atlas Night' },
                {
                  key: 'changes',
                  value:
                    'Colours, corners · reshapes sidebar, session rows, composer',
                },
                {
                  key: 'worksOn',
                  value: 'Everywhere',
                  note: 'Phones: all but 4 rules',
                },
                { key: 'licence', value: 'MIT' },
              ]}
              busy={null}
              onTryFace={setTrying}
              onRevert={() => setTrying(null)}
              onInstall={() => setTrying(null)}
              onRetryFaces={noop}
              testID="themes.specimen.listing"
            />
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function readCardKey(card: StoreThemeCardView): string {
  return card.key;
}

function passThrough(children: React.ReactNode) {
  return <>{children}</>;
}

const styles = StyleSheet.create((theme) => ({
  transcriptScroll: {
    paddingVertical: theme.space.s24,
    alignItems: 'center',
  },
  transcript: {
    width: '100%',
    maxWidth: 704,
    paddingHorizontal: theme.space.s16,
    gap: theme.space.s24,
  },
  scene: {
    gap: theme.space.s6,
  },
  sceneLabel: {
    color: theme.colors.text.tertiary,
  },
  storeRoot: {
    flex: 1,
    flexDirection: 'row',
  },
  storePage: {
    flex: 1,
  },
  pane: {
    width: 420,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface.base,
  },
}));
