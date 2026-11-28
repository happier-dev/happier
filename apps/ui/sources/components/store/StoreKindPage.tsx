import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { HappierCapabilityFactsInput } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { StoreProjectScopeChip } from './StoreProjectScopeChip';
import { StoreAppDefinitionEntries } from './StoreAppDefinitionEntries';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { ITEM_CHEVRON_SIZE } from '@/components/ui/lists/itemDensityMetrics';
import {
  Collection,
  type CollectionAnatomy,
  type CollectionGroupAction,
  useHappierCollection,
} from '@happier-dev/plugin-ui';
import { HAPPIER_PICKS_SOURCE_ID, type RegistrySourceDescriptorV1, type RegistryKindV1 } from '@happier-dev/protocol/registries';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';

import { RegistryShelfAddControl } from '@/components/capabilities/add/RegistryShelf';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { RegistrySourcesUnavailable } from '@/components/capabilities/add/RegistrySourcesUnavailable';
import { Text } from '@/components/ui/text/Text';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { registrySourceFailureLine, type RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { useMcpAdded, useSkillAdded, useAgentAdded, useProviderAdded } from './catalog/storeAdded';
import { useStoreOpenReference, useOpenStoreCategory } from './catalog/useStoreOpenReference';
import { StoreItemMark } from './catalog/StoreItemMark';
import { hydrateStoreRegistryIdentity, StoreRegistryIdentityProvider } from './catalog/StoreRegistryIdentity';
import { StoreListingPaneHost, StoreListingPaneOpenContext, useOpenStoreListing, useStoreListingSelection } from './StoreListing';
import { StoreBrowserExtensionLinkResult } from './StoreBrowserExtensionLinkResult';
import { readWebStoreExtensionId } from './catalog/storeBrowserExtensions';
import type { StoreListingReference } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import {
  storeKinds,
  type StoreAgentItem,
  type StoreKind,
} from './catalog/storeKinds';
import {
  type StoreKindList,
} from './StoreKindScreen';
import { storeEditorialGroupKey } from './catalog/storeColumnAdapter';
import { useStoreFilterFields } from './catalog/useStoreFilterFields';
import { StoreDirectory as StoreQueryDirectory, StoreSearch, type StoreSearchState } from './StoreSearch';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import { StoreDiscover } from './StoreDiscover';
import { StoreDiscoverItemMark } from './discover/StoreDirectorySection';
import { StoreDirectoryUnavailable } from './StoreDirectoryUnavailable';
import { kindCopy } from './catalog/storeKindCopy';
export { kindCopy } from './catalog/storeKindCopy';
import { projectStoreThemeCard, storeThemeSummary, themeSummaryMatchesMode, type StoreThemeItem } from './catalog/storeThemes';
import { STORE_THEME_CARD_MIN_WIDTH, useStoreThemeCardAnatomy } from './storeThemeCardAnatomy';
import { getThemeRegistryLifecycle } from '@/theme/profiles/themeTryOnRuntime';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { REGISTRY_SOURCE_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { StoreThemeCardView } from './storeThemeViewTypes';
import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { THEME_MINIATURE_CARD_MIN_WIDTH } from '@/components/settings/appearance/ThemeModePreview';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StoreMachineScopeContext, StoreMachineSelectionContext, useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { usePluginThemeSources } from '@/theme/profiles/usePluginThemeList';
import { accountPetRegistryKey, collectAddedRegistryPets, projectStorePetCard, type StorePetCardView, type StorePetItem } from './catalog/storePets';
import { STORE_PET_CARD_MIN_WIDTH, STORE_PET_CARD_MIN_WIDTH_PHONE, useStorePetCardAnatomy } from './storePetCardAnatomy';
import { useCreatePetSession } from '@/components/pets/useCreatePetSession';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { storage, usePeripheralFeedDemand } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

export type StoreDirectoryKind = Exclude<StoreKind, 'plugin' | 'software'>;
/** The catalog row's mark box draws a bare logo at this size inside it (S10 catalogRow). */
export const ROW_MARK_PX = 26;
/** Rows a long section previews before its All N › (two rows of the wide page's two columns). */
export const STORE_SECTION_PREVIEW_ROWS = 4;
/** The page is the scroller: the directory's Collection draws none of its own. */
const passThroughScroller = (children: React.ReactNode) => children;

/** One directory row: the native item it came from and how it reads, never a second identity. */
export type DirectoryRow = Readonly<{
  key: string;
  title: string;
  description: string | null;
  mark: React.ReactNode;
  group: string;
  facts?: HappierCapabilityFactsInput;
  /** Opens its listing (the pane beside the page, or its own page on a phone). */
  open: () => void;
  /** The + : the kind's own Add owner at this exact item. Defaults to `open` (rows whose home is a page). */
  add?: () => void;
  /** Native action wording for a mixed-kind directory. */
  addLabel?: string;
  /** The Account already holds this exact item (the kind's Installed reader); the + reads Added. */
  added?: boolean;
  /** Built-in entries open their own page; there is nothing to add. */
  addable?: boolean;
  /** The Registry item a catalog row stands for (`useRegistryRows`), for a host that picks one (Deploy an app). */
  item?: RegistryCatalogItemSummary;
}>;
export type DirectoryGroup = Readonly<{
  key: string;
  title: string;
  description?: string;
  /** Native categories and collections share Discover's source-qualified browse destination. */
  category?: Readonly<{ categoryId: string; catalogSourceId: string; total: number }>;
}>;

/** A Store kind page (lab `h:apps`, translated per kind): header, search with its catalog, then sections of catalog rows. */
export function StoreKindPage(
  props: Readonly<{ kind: StoreDirectoryKind; presented: boolean }>,
): React.ReactNode {
  const demand = React.useMemo(() => ({ presented: props.presented }), [props.presented]);
  const machine = useStoreMachineScope();
  const machineSelection = React.useContext(StoreMachineSelectionContext);
  if (props.kind === 'browserExtension' && machineSelection && !machine) return <BrowserExtensionMachineRequired presented={props.presented} />;
  return <StoreDiscover demand={demand} project={null}>{({ curation, complete }) =>
    <KindQuery {...props} demand={demand} curation={curation.curation} curationComplete={complete}
      curationRead={curation.layout} />
  }</StoreDiscover>;
}

function BrowserExtensionMachineRequired(props: Readonly<{ presented: boolean }>) {
  const directory = useStoreDirectoryState();
  const machineSelection = React.useContext(StoreMachineSelectionContext)!;
  const query = directory.state?.query ?? '';
  return <StoreKindFrame kind="browserExtension" presented={props.presented}
    query={query} onQueryChange={directory.setQuery}>
    {props.presented ? <StoreBrowserExtensionLinkResult query={query} /> : null}
    <SurfaceStateCard kind="unavailable" size="page" testID="store.kind.browserExtension.needsMachine"
      title={t('widgetGlances.needsMachineTitle')} reason={t('capabilities.store.kinds.browserExtension.chooseMachine')}
      action={{ label: t('settingsPlugins.targetSelection.chooseMachine'), onPress: () => machineSelection.setPickerOpen(true) }} />
  </StoreKindFrame>;
}

/** Reads admitted editorial pages and their stable layout state; other catalog publications leave the page still. */
const KindQuery = React.memo(function KindQuery(props: Readonly<{ kind: StoreDirectoryKind; presented: boolean;
  demand: Readonly<{ presented: boolean }>; curation: RegistryCuration['curation']; curationComplete: boolean; curationRead: RegistryCuration['layout'] }>) {
  const fields = useStoreFilterFields(props.curation, props.presented);
  const directory = useStoreDirectoryState();
  const source = directory.state?.filters.source;
  const sourceIsStated = props.kind !== 'provider' && source?.include.length === 1 && source.exclude.length === 0;
  return <StoreQueryDirectory kind={props.kind} demand={props.demand} fields={fields}
    statedFields={sourceIsStated ? ['source'] : undefined}
    curation={props.curation} curationComplete={props.curationComplete}
    unavailable={<StoreDirectoryUnavailable view="kind" kind={props.kind} />}>
    {state => <KindResults kind={props.kind} presented={props.presented} state={state} curation={props.curation}
      curationRead={props.curationRead} />}
  </StoreQueryDirectory>;
});

function KindResults(props: Readonly<{ kind: StoreDirectoryKind; presented: boolean; state: StoreSearchState;
  curation: RegistryCuration['curation']; curationRead: RegistryCuration['layout'] }>) {
  const { state } = props;
  const { filter } = state;
  const source = filter.filters.source;
  const sourceId = source?.include.length === 1 && source.exclude.length === 0 ? source.include[0]! : null;
  const setSourceId = React.useCallback((id: string | null) => filter.setFilters(filters => {
    const { source: _source, ...rest } = filters;
    return id ? { ...rest, source: { include: [id], exclude: [] } } : rest;
  }), [filter.setFilters]);
  const visible = React.useMemo(() => new Set(state.rows), [state.rows]);
  const registryItems = React.useMemo(() => state.rows.filter((row): row is RegistryCatalogItemSummary => 'kind' in row && 'itemId' in row), [state.rows]);
  const themeItems = React.useMemo(() => state.lists.theme?.items.filter(item => visible.has(item)) ?? EMPTY_CURATED,
    [state.lists.theme?.items, visible]);
  const browsing = !state.query.trim() && Object.keys(filter.filters).length === 0;
  // Which modes a theme covers narrows the Themes page from its filter row, beside the catalog (lab C1).
  const [themeMode, setThemeMode] = React.useState<ThemeProfileMode | null>(null);
  const frame = (body: React.ReactNode) => (
    <StoreRegistryIdentityProvider items={registryItems}>
    <StoreKindFrame
      kind={props.kind}
      query={state.query}
      onQueryChange={state.setQuery}
      sourceId={sourceId}
      onSourceChange={setSourceId}
      presented={props.presented}
      filter={filter}
      {...(props.kind === 'theme' ? { condition: <ThemeModeFilter mode={themeMode} onModeChange={setThemeMode} /> } : {})}
    >
      {body}
    </StoreKindFrame>
    </StoreRegistryIdentityProvider>
  );
  // Browsing stays held only while its editorial positions first arrive. A failed cold curation hides nothing: the
  // kind's own catalogs and built-ins list below, with the curated source's outage line above them (J03).
  // A retry after a settled failure is not a first arrival: the rows already shown stay (never flash back to loading).
  const curationSettled = React.useRef(false);
  if (!props.curationRead.loading) curationSettled.current = true;
  if (!(props.kind === 'theme' && state.lists.theme?.items.some(item => item.kind === 'pluginTheme'))
    && kindPageWaitsForCuration({ browsing, kind: props.kind, curationRead: props.curationRead, settled: curationSettled.current })) return frame(
    <SkeletonRows testID={`store.kind.${props.kind}.loading`} rows={5} accessibilityLabel={t('common.loading')} />);
  switch (props.kind) {
    case 'browserExtension':
      // A pasted Chrome Web Store link or ID installs that extension, whether or not the catalog lists it or is reachable.
      return frame(<><StoreBrowserExtensionLinkResult query={state.query} />{state.lists.browserExtension
        ? <RegistryDirectory kind="browserExtension" list={{ ...state.lists.browserExtension, curation: [...props.curation, ...state.lists.browserExtension.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.browserExtension.sourceFailures],
          items: state.lists.browserExtension.items.filter(item => visible.has(item)) }} query={state.query} browsing={browsing} onSeeSource={setSourceId}
          showEmptyState={readWebStoreExtensionId(state.query) === null} />
        : <Directory kind={props.kind} rows={[]} groups={[]} list={{ loading: false, hasNextPage: false }} query={state.query} sourceTitle={null}
          showEmptyState={readWebStoreExtensionId(state.query) === null} />}</>);
    case 'starter':
      if (state.lists.starter) return frame(<RegistryDirectory kind="starter" addLabel={t('capabilities.store.startProject')} list={{ ...state.lists.starter, curation: [...props.curation, ...state.lists.starter.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.starter.sourceFailures],
          items: state.lists.starter.items.filter(item => visible.has(item)) }} query={state.query} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'app':
      if (state.lists.app) return frame(<RegistryDirectory kind="app" list={{ ...state.lists.app, curation: [...props.curation, ...state.lists.app.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.app.sourceFailures],
        items: state.lists.app.items.filter(item => visible.has(item)) }} query={state.query} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'theme':
      if (state.lists.theme) return frame(<ThemeDirectory list={{ ...state.lists.theme, items: themeItems }} query={state.query}
        mode={themeMode} onModeChange={setThemeMode} />);
      break;
    case 'pet':
      if (state.lists.pet) return frame(<PetDirectory list={{ ...state.lists.pet, curation: [...props.curation, ...state.lists.pet.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.pet.sourceFailures],
          items: state.lists.pet.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented}
          browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'mcpServer':
      if (state.lists.mcpServer) return frame(<McpDirectory list={{ ...state.lists.mcpServer, curation: [...props.curation, ...state.lists.mcpServer.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.mcpServer.sourceFailures],
        items: state.lists.mcpServer.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'skill':
      if (state.lists.skill) return frame(<SkillDirectory list={{ ...state.lists.skill, curation: [...props.curation, ...state.lists.skill.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.skill.sourceFailures],
        items: state.lists.skill.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'agent':
      if (state.lists.agent) return frame(<AgentDirectory list={{ ...state.lists.agent, curation: [...props.curation, ...state.lists.agent.curation],
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.agent.sourceFailures],
        items: state.lists.agent.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'provider':
      if (state.lists.provider) return frame(<ProviderDirectory list={{ ...state.lists.provider,
        items: state.lists.provider.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented} />);
      break;
  }
  return frame(<Directory kind={props.kind} rows={[]} groups={[]} list={{ loading: false, hasNextPage: false }} query={state.query} sourceTitle={null} />);
}

/** The one decision on whether a kind page waits for curated positions: only while a cold curation is arriving. */
export function kindPageWaitsForCuration(input: Readonly<{ browsing: boolean; kind: StoreDirectoryKind;
  curationRead: Readonly<{ hasValue: boolean; loading: boolean }>; settled?: boolean }>): boolean {
  return input.browsing && input.kind !== 'provider' && !input.curationRead.hasValue && input.curationRead.loading
    && input.settled !== true;
}

/** A kind page's frame: header, search with its one condition beside it, the directory, and the listing pane. */
export function StoreKindFrame(
  props: Readonly<{
    kind: StoreDirectoryKind | 'software' | 'bot';
    query: string;
    onQueryChange: (query: string) => void;
    sourceId?: string | null;
    onSourceChange?: (sourceId: string | null) => void;
    /** A kind whose condition is not a catalog (Software reads one Machine) supplies its own control; `fill` is true where it stacks under the search (a phone). */
    accessory?: React.ReactNode;
    /** The kind's one either-or (Themes' Any | Light | Dark): it ends the filter row on a wide page and takes its own row on a phone. */
    condition?: React.ReactNode;
    presented: boolean;
    filter?: StoreSearchState['filter'];
    children: React.ReactNode;
  }>,
): React.ReactNode {
  const copy = kindCopy(props.kind);
  const registryKind =
    props.kind === 'provider' || props.kind === 'software' ? null : props.kind === 'bot' ? 'plugin' : props.kind;
  // A phone has no room for the condition beside the search: it stacks under it at full width.
  const stacked = useDeviceType() === 'phone';
  const machineSelection = React.useContext(StoreMachineSelectionContext);
  const scopeChip = props.kind === 'browserExtension' && machineSelection
    ? <MachineAdministrationTargetSelector selection={machineSelection.selection} presentation="chip"
      testIDPrefix="store.browserExtension.machine" chipOpen={machineSelection.pickerOpen} onChipOpenChange={machineSelection.setPickerOpen} />
    : <StoreProjectScopeChip />;
  const registrySelect = registryKind && props.onSourceChange ? (
    <CatalogSelect
      kind={registryKind}
      presented={props.presented}
      sourceId={props.sourceId ?? null}
      onSourceChange={props.onSourceChange}
    />
  ) : undefined;
  // Software reads one Machine; Bot templates and portable themes belong to no project.
  const scoped = props.kind !== 'software' && props.kind !== 'bot' && props.kind !== 'theme' && props.kind !== 'pet';
  // A kind's own create entry (Apps' definitions, Create a pet…): the header actions on wide pages, the band on a phone.
  const createEntry = props.kind === 'app' ? <StoreAppDefinitionEntries /> : props.kind === 'pet' ? <CreatePetEntry /> : null;
  return (
    <StoreListingPaneHost title={copy.title} testID={`store.kind.${props.kind}`}>
    <StoreKindFrameBody kind={props.kind} title={copy.title} description={copy.description} search={copy.search}
      stacked={stacked} scoped={scoped} createEntry={createEntry} scopeChip={scopeChip} query={props.query}
      onQueryChange={props.onQueryChange} {...(props.filter ? { filter: props.filter } : {})}
      {...(props.accessory ? { accessory: props.accessory } : {})} {...(registrySelect ? { registrySelect } : {})}
      {...(props.condition ? { condition: props.condition } : {})}>
      {props.children}
    </StoreKindFrameBody>
    </StoreListingPaneHost>
  );
}

/**
 * A kind page's head and directory, inside the listing pane host: with a listing open beside it the head keeps one
 * toolbar row, so the catalog choice leaves the band for the search's filter menu (its Source condition; UI
 * refinements 2026-11-18, Store toolbar).
 */
export function StoreKindFrameBody(props: Readonly<{
  kind: StoreDirectoryKind | 'software' | 'bot';
  title: string;
  description: string;
  search: string;
  stacked: boolean;
  scoped: boolean;
  createEntry: React.ReactNode;
  scopeChip: React.ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  filter?: StoreSearchState['filter'];
  accessory?: React.ReactNode;
  registrySelect?: React.ReactNode;
  condition?: React.ReactNode;
  children: React.ReactNode;
}>): React.ReactNode {
  const paneOpen = React.useContext(StoreListingPaneOpenContext);
  // With a listing open beside the directory, what narrows the page leaves the toolbar for the band ("what narrows
  // the page sits in its band"): the catalog choice is the filter menu's Source condition, and the project scope
  // chip stands in the band's filter row, so the toolbar keeps one row at 1440 (PAGE-ACCEPT-176 R3-D5).
  const scopeInBand = paneOpen && props.scoped && !props.stacked;
  const accessory = props.accessory ?? (paneOpen ? scopeInBand ? props.scopeChip : undefined : props.registrySelect);
  const headerScope = scopeInBand ? null : props.scopeChip;
  return (
    <ItemList pageColumn="wide" testID={`store.kind.${props.kind}`}>
      <PageContentColumn>
        {/* The main-screen head every main page draws (ruling 11-13): its search behind the magnifier like any main
            page, the funnel ending the field; what narrows the page (catalog, Machine, conditions) sits in its band. */}
        <MainScreenHeader
          testID={`store.kind.${props.kind}.header`}
          title={props.title}
          description={props.description}
          {...(props.stacked ? {} : props.scoped && headerScope ? { actions: props.createEntry
            ? <View style={styles.headerActions}>{props.createEntry}{headerScope}</View> : headerScope } : props.createEntry ? { actions: props.createEntry } : {})}
          search={{
            value: props.query,
            onChangeText: props.onQueryChange,
            placeholder: props.search,
            testID: `store.kind.${props.kind}.search`,
            ...(props.filter?.filterButton ? { trailing: props.filter.filterButton } : {}),
          }}
          band={props.stacked || accessory || props.condition || props.filter?.tokenRow ? <>
            {props.stacked ? <>
              <View style={styles.phoneScope}>{props.scoped ? props.scopeChip : null}{accessory}{props.createEntry}</View>
              {props.condition ?? null}
            </> : accessory || props.condition ? (
              // One filter row: what narrows the page by catalog leads, the kind's either-or ends it, on one line.
              <View style={styles.filterRow}>
                {accessory}
                {props.condition ? <View style={styles.filterRowEnd}>{props.condition}</View> : null}
              </View>
            ) : null}
            {props.filter?.tokenRow ?? null}
          </> : undefined}
        />
        {props.children}
      </PageContentColumn>
    </ItemList>
  );
}

/** Only registry-backed kinds choose a catalog (S40 §5); it narrows remote demand before fetching. */
function CatalogSelect(
  props: Readonly<{
    kind: RegistryKindV1;
    presented: boolean;
    sourceId: string | null;
    onSourceChange: (sourceId: string | null) => void;
  }>,
): React.ReactNode {
  const registry = useRegistrySources(props.kind, props.presented);
  const pluginSources = usePluginThemeSources(props.presented && props.kind === 'theme');
  const sources = [...registry.sources.filter((source) => source.enabled),
    ...Array.from(pluginSources, ([id, title]) => ({ id, title }))];
  // Held in place while the catalogs load, so the search beside it never changes width on arrival.
  if (registry.hasValue && sources.length < 2 && props.sourceId === null) return null;
  return (
    <SelectionListFilterChip filter={{
      id: 'store-catalog',
      testID: `store.kind.${props.kind}.catalog`,
      label: t('capabilities.store.catalogLabel'),
      options: [
        { id: 'all', label: t('capabilities.store.allCatalogs') },
        ...sources.map((source) => ({ id: source.id, label: source.title })),
      ],
      selectedId: props.sourceId ?? 'all',
      onChange: (id) => props.onSourceChange(id === 'all' ? null : id),
      disabled: !registry.hasValue && pluginSources.size === 0,
    }} />
  );
}

type RegistryList = StoreKindList<'mcpServer'>;

/**
 * Browsing a kind with several sections: each catalog's section previews its first rows and keeps the rest behind its
 * All N ›, which narrows this same page to that catalog (lab h:apps). A page whose only section is that catalog stays whole.
 */
export function previewSourceSections<Row extends Readonly<{ group: string }>>(input: Readonly<{
  rows: readonly Row[];
  groups: readonly Readonly<{ key: string }>[];
  pages: readonly Readonly<{ sourceId: string; nextCursor: string | null }>[];
  /** Null while conditions already narrow the page. */
  onSeeSource: ((sourceId: string) => void) | null;
}>): Readonly<{ rows: readonly Row[]; capped: boolean; groupAction?: (groupKey: string) => CollectionGroupAction | null }> {
  const { rows, groups, pages, onSeeSource } = input;
  if (!onSeeSource || groups.length < 2) return { rows, capped: false };
  const counts = new Map<string, number>();
  for (const row of rows) if (row.group.startsWith(SOURCE_GROUP_PREFIX)) counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
  const shown = new Map<string, number>();
  const preview = rows.filter(row => {
    if (!row.group.startsWith(SOURCE_GROUP_PREFIX)) return true;
    const next = (shown.get(row.group) ?? 0) + 1;
    shown.set(row.group, next);
    return next <= STORE_SECTION_PREVIEW_ROWS;
  });
  if (preview.length === rows.length) return { rows, capped: false };
  const groupAction = (groupKey: string): CollectionGroupAction | null => {
    const count = counts.get(groupKey) ?? 0;
    if (count <= STORE_SECTION_PREVIEW_ROWS || !groupKey.startsWith(SOURCE_GROUP_PREFIX)) return null;
    const sourceId = groupKey.slice(SOURCE_GROUP_PREFIX.length);
    const known = pages.find(page => page.sourceId === sourceId)?.nextCursor == null && pages.some(page => page.sourceId === sourceId);
    return { label: known ? t('capabilities.store.search.allOf', { count }) : t('capabilities.store.search.all'),
      onPress: () => onSeeSource(sourceId), kind: 'link' };
  };
  return { rows: preview, capped: true, groupAction };
}

const SOURCE_GROUP_PREFIX = 'source:';
const EMPTY_CURATED: readonly RegistryCatalogItemSummary[] = [];
const curatedIdentity = (item: RegistryCatalogItemSummary) => JSON.stringify([item.sourceId, item.itemId]);

type ThemeDirectoryRow = DirectoryRow & Readonly<{ card: StoreThemeCardView }>;

/** Both Store entry points compose registry rows with the joined library's plugin references. */
export function useStoreThemeRows(list: Readonly<{ items: readonly StoreThemeItem[]; curation: RegistryList['curation'] }>,
  openRegistry: (item: RegistryCatalogItemSummary) => void, sourceTitle: (sourceId: string) => string) {
  const open = useOpenStoreListing();
  const scope = useAccountSettingsScope();
  const presented = useLayoutPresentationActive();
  const lifecycle = getThemeRegistryLifecycle();
  const latestOpen = React.useRef(open);
  latestOpen.current = open;
  const held = React.useRef<Readonly<{ rows: readonly ThemeDirectoryRow[]; groups: readonly DirectoryGroup[] }> | null>(null);
  const candidates = React.useMemo(() => list.items.filter((item): item is RegistryCatalogItemSummary => item.kind !== 'pluginTheme'), [list.items]);
  const subscribe = React.useCallback((notify: () => void) => {
    const stop = presented ? candidates.flatMap(item => item.version
      ? [lifecycle.subscribePreview({ sourceId: item.sourceId, itemId: item.itemId, version: item.version }, scope, notify)] : []) : [];
    return () => { for (const dispose of stop) dispose(); };
  }, [candidates, lifecycle, scope, presented]);
  const read = React.useCallback(() => JSON.stringify(candidates.filter(item => item.version
    && lifecycle.isPreviewExcluded({ sourceId: item.sourceId, itemId: item.itemId, version: item.version }, scope)).map(item => item.itemId)),
  [candidates, lifecycle, scope]);
  const exclusions = React.useSyncExternalStore(subscribe, read, read);
  const registryItems = React.useMemo(() => candidates.filter(item => !item.version
    || !lifecycle.isPreviewExcluded({ sourceId: item.sourceId, itemId: item.itemId, version: item.version }, scope)),
  [candidates, lifecycle, scope, exclusions]);
  const registry = useRegistryRows({ items: registryItems, curation: list.curation }, openRegistry, sourceTitle);
  return React.useMemo(() => {
    const before = held.current;
    const previousRows = new Map(before?.rows.map(row => [row.key, row]));
    const plugins = list.items.flatMap((item): ThemeDirectoryRow[] => {
      if (item.kind !== 'pluginTheme') return [];
      const summary = storeThemeSummary(item);
      return [{ key: summary.key, title: summary.title, description: item.pluginName, mark: null,
        group: `plugin:${item.pluginId}`, card: projectStoreThemeCard(item, item.pluginName),
        open: previousRows.get(summary.key)?.open ?? (() => latestOpen.current({ type: 'pluginTheme', reference: {
          kind: 'plugin', pluginId: item.pluginId, contributionId: item.contributionId } })) }];
    });
    const cards = new Map(registryItems.map(item => { const card = projectStoreThemeCard(item, sourceTitle(item.sourceId)); return [card.key, card] as const; }));
    const rows = registry.rows.flatMap((row): ThemeDirectoryRow[] => { const card = cards.get(row.key); return card ? [{ ...row, card }] : []; });
    const groups = new Map(plugins.map(row => [row.group, { key: row.group, title: row.card.byline }]));
    const retainedRows = retainKeyedRows(before?.rows, [...plugins, ...rows], row => row.key);
    const retainedGroups = retainKeyedRows(before?.groups, [...groups.values(), ...registry.groups], group => group.key);
    if (before?.rows === retainedRows && before.groups === retainedGroups) return before;
    held.current = { rows: retainedRows, groups: retainedGroups };
    return held.current;
  }, [list.items, registryItems, registry.rows, registry.groups, sourceTitle, open]);
}

/** The shared directory owns selection, source failures and pagination; UI-B supplies the card anatomy. */
function ThemeDirectory(props: Readonly<{ list: StoreKindList<'theme'>; query: string; mode: ThemeProfileMode | null;
  onModeChange: (mode: ThemeProfileMode | null) => void }>) {
  const { mode, onModeChange: setMode } = props;
  const phone = useDeviceType() === 'phone';
  const open = useOpenRegistryItem();
  const sourceTitle = useSourceTitle();
  const items = React.useMemo(() => props.list.items.filter(item => themeSummaryMatchesMode(item, mode)), [props.list.items, mode]);
  const registry = useStoreThemeRows({ items, curation: props.list.curation }, open, sourceTitle);
  const rows = registry.rows;
  const cardAnatomy = useStoreThemeCardAnatomy();
  const anatomy = React.useMemo<CollectionAnatomy<ThemeDirectoryRow>>(() => ({
    glyph: row => cardAnatomy.glyph(row.card),
    title: row => cardAnatomy.title(row.card),
    where: row => cardAnatomy.where?.(row.card),
    reason: row => cardAnatomy.reason?.(row.card),
    preview: row => cardAnatomy.preview?.(row.card),
    ...(cardAnatomy.previewAspectRatio ? { previewAspectRatio: cardAnatomy.previewAspectRatio } : {}),
    accessibilityLabel: row => cardAnatomy.accessibilityLabel?.(row.card) ?? row.title,
    testID: row => cardAnatomy.testID?.(row.card) ?? row.key,
    columnTitles: cardAnatomy.columnTitles,
  }), [cardAnatomy]);
  const modeLabel = mode === null ? t('themeStore.anyMode') : mode === 'light' ? t('themeCard.light') : t('themeCard.dark');
  return <Directory kind="theme" rows={rows} groups={registry.groups} list={props.list} sourceTitle={sourceTitle}
    query={props.query || (mode === null ? '' : modeLabel)}
    {...(!props.query && mode !== null ? { onClear: () => setMode(null) } : {})}
    anatomy={anatomy} presentation="grid"
    // Phones keep two miniatures across (lab C1P); wider pages three across, two beside the open listing (C2).
    minCardWidth={phone ? THEME_MINIATURE_CARD_MIN_WIDTH : STORE_THEME_CARD_MIN_WIDTH} />;
}

/** Which modes a theme covers is a 2–4 option either-or: the one segmented control (finding 3), kept on phones. */
function ThemeModeFilter(props: Readonly<{ mode: ThemeProfileMode | null; onModeChange: (mode: ThemeProfileMode | null) => void }>) {
  const phone = useDeviceType() === 'phone';
  return <SegmentedTabBar<'any' | ThemeProfileMode> role="radiogroup" segmentSizing={phone ? 'equal' : 'content'}
    accessibilityLabel={t('themeStore.modeFilter')} testIDPrefix="store.theme.modes" activeTabId={props.mode ?? 'any'}
    onSelectTab={id => props.onModeChange(id === 'any' ? null : id)}
    tabs={[{ id: 'any', label: t('themeStore.anyMode'), testID: 'store.theme.modes.any' },
      { id: 'light', label: t('themeCard.light'), testID: 'store.theme.modes.light' },
      { id: 'dark', label: t('themeCard.dark'), testID: 'store.theme.modes.dark' }]} />;
}

type PetDirectoryRow = DirectoryRow & Readonly<{ card: StorePetCardView }>;
const isRegistryPet = (item: StorePetItem): item is RegistryCatalogItemSummary => item.kind !== 'builtInPet';

/**
 * Store › Pets (lab r12-store-A): Built-in first with its own All N ›, then one section per pet catalog previewing its
 * first row behind All N ›, all as pet cards on the shared directory (source states, selection, Load more).
 */
function PetDirectory(props: Readonly<{ list: StoreKindList<'pet'>; query: string; presented: boolean; browsing: boolean;
  onSeeSource: (sourceId: string) => void }>) {
  const phone = useDeviceType() === 'phone';
  const openRegistry = useOpenRegistryItem();
  const openListing = useOpenStoreListing();
  const sourceTitle = useSourceTitle();
  const syncEnabled = useFeatureEnabled('pets.sync');
  usePeripheralFeedDemand('accountPets', props.presented && syncEnabled);
  const accountPetsById = storage(state => state.accountPetsById);
  const held = React.useMemo(() => collectAddedRegistryPets(accountPetsById), [accountPetsById]);
  const isAdded = React.useCallback((item: RegistryCatalogItemSummary) => held.has(accountPetRegistryKey(item.sourceId, item.itemId)), [held]);
  const registryItems = React.useMemo(() => props.list.items.filter(isRegistryPet), [props.list.items]);
  const registryList = React.useMemo(() => ({ items: registryItems, curation: props.list.curation,
    ...(props.browsing ? { curatedKind: 'pet' as const } : {}) }), [registryItems, props.list.curation, props.browsing]);
  const registry = useRegistryRows(registryList, openRegistry, sourceTitle, isAdded);
  const [allBuiltIns, setAllBuiltIns] = React.useState(false);
  const builtIns = React.useMemo(() => props.list.items.flatMap((item): PetDirectoryRow[] => item.kind !== 'builtInPet' ? [] : [{
    key: `pet|builtIn|${item.pet.id}`, title: item.pet.manifest.displayName, description: null, mark: null, group: 'builtIn',
    addable: false, card: projectStorePetCard(item, '', false), open: () => openListing({ type: 'builtInPet', petId: item.pet.id }),
  }]), [props.list.items, openListing]);
  const rows = React.useMemo(() => {
    const cards = new Map(registryItems.map(item => {
      const card = projectStorePetCard(item, sourceTitle(item.sourceId), isAdded(item));
      return [card.key, card] as const;
    }));
    const shownBuiltIns = props.browsing && !allBuiltIns ? builtIns.slice(0, STORE_SECTION_PREVIEW_ROWS) : builtIns;
    return [...shownBuiltIns, ...registry.rows.flatMap((row): PetDirectoryRow[] => {
      const card = cards.get(row.key);
      return card ? [{ ...row, card }] : [];
    })];
  }, [registryItems, sourceTitle, isAdded, builtIns, props.browsing, allBuiltIns, registry.rows]);
  const groups = React.useMemo(() => [
    ...(builtIns.length ? [{ key: 'builtIn', title: t('capabilities.store.builtIn'), description: t('settingsPets.store.builtInDescription') }] : []),
    ...registry.groups,
  ], [builtIns.length, registry.groups]);
  const preview = useSourceSectionPreview(rows, groups, props.list, props.browsing ? props.onSeeSource : undefined);
  const groupAction = React.useCallback((groupKey: string): CollectionGroupAction | null => {
    if (groupKey !== 'builtIn') return preview.groupAction?.(groupKey) ?? null;
    return props.browsing && !allBuiltIns && builtIns.length > STORE_SECTION_PREVIEW_ROWS
      ? { label: t('capabilities.store.search.allOf', { count: builtIns.length }), kind: 'link', onPress: () => setAllBuiltIns(true) } : null;
  }, [preview.groupAction, props.browsing, allBuiltIns, builtIns.length]);
  const cardAnatomy = useStorePetCardAnatomy();
  const anatomy = React.useMemo<CollectionAnatomy<PetDirectoryRow>>(() => ({
    glyph: row => cardAnatomy.glyph(row.card),
    title: row => cardAnatomy.title(row.card),
    where: row => cardAnatomy.where?.(row.card),
    reason: row => cardAnatomy.reason?.(row.card),
    preview: row => cardAnatomy.preview?.(row.card),
    accessibilityLabel: row => cardAnatomy.accessibilityLabel?.(row.card) ?? row.title,
    testID: row => cardAnatomy.testID?.(row.card) ?? row.key,
    columnTitles: cardAnatomy.columnTitles,
  }), [cardAnatomy]);
  return <Directory kind="pet" rows={preview.rows as readonly PetDirectoryRow[]} groups={groups} list={preview.list}
    query={props.query} sourceTitle={sourceTitle} anatomy={anatomy} presentation="grid" groupAction={groupAction}
    minCardWidth={phone ? STORE_PET_CARD_MIN_WIDTH_PHONE : STORE_PET_CARD_MIN_WIDTH} />;
}

/** Create a pet… (decision 13): the one entry the Store, Settings › Pets and the face chooser share. */
function CreatePetEntry(): React.ReactNode {
  const createPet = useCreatePetSession();
  return <RoundButton size="small" display="secondary" testID="store.kind.pet.create" title={t('settingsPets.store.create')}
    onPress={() => fireAndForget(createPet(), { tag: 'StoreKindPage.createPet' })} />;
}

/** A kind's curated items as summaries, from the words the catalog's curation already holds. */
function curatedSummaries(curation: RegistryList['curation'], kind: RegistryCatalogItemSummary['kind']): readonly RegistryCatalogItemSummary[] {
  const seen = new Set<string>();
  return curation.flatMap(page => page.discovery.items.flatMap((item): RegistryCatalogItemSummary[] => {
    const reference = item.reference;
    if (reference.type !== 'registryItem' || reference.kind !== kind) return [];
    const identity = JSON.stringify([reference.sourceId, reference.itemId]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ sourceId: reference.sourceId, itemId: reference.itemId, kind, title: item.title,
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(reference.version === undefined ? {} : { version: reference.version }), flags: { pick: true } }];
  }));
}

/** Native App catalogs lead; within each tier, picks and curated categories precede other catalogs. */
export function useRegistryRows(
  list: Readonly<{ items: readonly RegistryCatalogItemSummary[]; curation: RegistryList['curation'];
    sources?: readonly Pick<RegistrySourceDescriptorV1, 'id' | 'format' | 'kinds'>[];
    /** Browsing this kind unfiltered: its curated items lead the page even before their catalog page has loaded. */
    curatedKind?: RegistryCatalogItemSummary['kind'] }>,
  open: (item: RegistryCatalogItemSummary) => void,
  sourceTitle: (sourceId: string) => string,
  isAdded?: (item: RegistryCatalogItemSummary) => boolean,
  add?: (item: RegistryCatalogItemSummary) => void,
): Readonly<{
  rows: readonly DirectoryRow[];
  groups: readonly DirectoryGroup[];
}> {
  // A row is the Collection's unit of work: the one built for an item keeps its identity while that item, its group
  // and its added state stay the same, however the list around it (a search narrowing it) or the caller's callbacks change.
  const latest = React.useRef({ open, add });
  latest.current = { open, add };
  const held = React.useRef<ReadonlyMap<string, Readonly<{
    item: RegistryCatalogItemSummary; group: string; added: boolean; addable: boolean; row: DirectoryRow;
  }>>>(new Map());
  const published = React.useRef<Readonly<{ rows: readonly DirectoryRow[]; groups: readonly DirectoryGroup[] }> | null>(null);
  const curatedItems = React.useMemo(() => list.curatedKind ? curatedSummaries(list.curation, list.curatedKind) : EMPTY_CURATED,
    [list.curation, list.curatedKind]);
  return React.useMemo(() => {
    const curatedByIdentity = new Map(curatedItems.map(item => [curatedIdentity(item), item]));
    const categories = new Map<
      string,
      Readonly<{ title: string; description?: string; members: Set<string>; category: NonNullable<DirectoryGroup['category']> }>
    >();
    for (const page of list.curation) {
      const byId = new Map(
        page.discovery.items.map((item) => [item.id, item.reference]),
      );
      for (const category of page.discovery.categories) {
        const members = new Set<string>();
        for (const id of category.items) {
          const ref = byId.get(id);
          if (ref?.type === 'registryItem')
            members.add(JSON.stringify([ref.sourceId, ref.itemId]));
        }
        categories.set(storeEditorialGroupKey(page.sourceId, category.id), {
          title: category.title,
          ...(category.description
            ? { description: category.description }
            : {}),
          members, category: { categoryId: category.id, catalogSourceId: page.sourceId, total: category.items.length },
        });
      }
    }
    const nativeAppSources = new Set((list.sources ?? []).filter(source =>
      source.format === 'happier-catalog' && source.kinds.includes('app')).map(source => source.id));
    const nativeAppGroups = new Set<string>();
    const groups = new Map<string, DirectoryGroup>();
    const next = new Map<string, Readonly<{
      item: RegistryCatalogItemSummary; group: string; added: boolean; addable: boolean; row: DirectoryRow;
    }>>();
    const loaded = new Map(list.items.map(item => [curatedIdentity(item), item]));
    // Hydration retains the authored pin in its editorial slot; it never appends that row elsewhere.
    const items = [...curatedItems.map(item => hydrateStoreRegistryIdentity(item, loaded.get(curatedIdentity(item)))),
      ...list.items.filter(item => !curatedByIdentity.has(curatedIdentity(item)))];
    const rows = items.map((item): DirectoryRow => {
      const identity = JSON.stringify([item.sourceId, item.itemId]);
      const category =
        item.sourceId === HAPPIER_PICKS_SOURCE_ID
          ? null
          : [...categories].find(([, value]) => value.members.has(identity));
      const group: DirectoryGroup =
        item.sourceId === HAPPIER_PICKS_SOURCE_ID || (!category && curatedByIdentity.has(identity))
          ? {
              key: 'picks',
              title: t('capabilities.store.picksTitle'),
              description: t('capabilities.store.picksDescription'),
            }
          : category
            ? {
                key: `category:${category[0]}`,
                title: category[1].title,
                category: category[1].category,
                ...(category[1].description
                  ? { description: category[1].description }
                  : {}),
              }
            : {
                key: `${SOURCE_GROUP_PREFIX}${item.sourceId}`,
                title: t('capabilities.store.fromSource', {
                  source: sourceTitle(item.sourceId),
                }),
              };
      if (item.kind === 'app' && nativeAppSources.has(item.sourceId)) nativeAppGroups.add(group.key);
      if (!groups.has(group.key)) groups.set(group.key, group);
      const key = `${item.kind}|${item.sourceId}|${item.itemId}`;
      const added = isAdded?.(item) ?? false;
      const addable = add !== undefined;
      // Curation owns the visible words as well as their positions; hydration supplies native facts and artwork.
      const presentation = curatedByIdentity.get(identity) ?? item;
      const description = presentation.description?.trim() || null;
      const previous = held.current.get(key);
      const row: DirectoryRow = previous && previous.item === item && previous.group === group.key
        && previous.added === added && previous.addable === addable
        && previous.row.title === presentation.title && previous.row.description === description ? previous.row : {
        key,
        title: presentation.title,
        description,
        group: group.key,
        item,
        open: () => latest.current.open(item),
        ...(addable ? { add: () => latest.current.add?.(item) } : {}),
        added,
        // The item's one mark (its listing's artwork, else its kind glyph), as Discover and Search draw it.
        // Curation carries no artwork: a curated row reads it the way Discover does, until its catalog page arrives.
        mark: loaded.get(identity) !== item ? <StoreDiscoverItemMark size={ROW_MARK_PX} item={{ key: identity, id: item.itemId, sourceId: item.sourceId,
          kind: item.kind, title: item.title, description: null,
          reference: { type: 'registryItem', kind: item.kind, sourceId: item.sourceId, itemId: item.itemId,
            ...(item.version === undefined ? {} : { version: item.version }) } }} />
          : <StoreItemMark facts={{ kind: item.kind, title: item.title, brand: item.brandMark }} size={ROW_MARK_PX} />,
      };
      next.set(key, { item, group: group.key, added, addable, row });
      return row;
    });
    held.current = next;
    // Native App catalogs precede imported tools; editorial order within each tier is independent of arrival order.
    const editorialOrder = new Map(['picks', ...[...categories.keys()].map(key => `category:${key}`)]
      .map((key, index) => [key, index]));
    const orderedGroups = [...groups.values()].sort((left, right) =>
      Number(nativeAppGroups.has(right.key)) - Number(nativeAppGroups.has(left.key))
      || (editorialOrder.get(left.key) ?? editorialOrder.size) - (editorialOrder.get(right.key) ?? editorialOrder.size));
    const before = published.current;
    const same = before !== null && before.rows.length === rows.length && before.rows.every((row, index) => row === rows[index])
      && before.groups.length === orderedGroups.length
      && before.groups.every((group, index) => group.key === orderedGroups[index]!.key
        && group.title === orderedGroups[index]!.title && group.description === orderedGroups[index]!.description
        && group.category?.total === orderedGroups[index]!.category?.total);
    if (same) return before;
    published.current = { rows, groups: orderedGroups };
    return published.current;
  }, [list.curation, list.items, list.sources, curatedItems, open, sourceTitle, isAdded, add]);
}

/** Catalog facts and names share the Account's existing source subscription. */
export function useSourceCatalog() {
  const registry = useRegistrySources();
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      registry.sources.find((source) => source.id === sourceId)?.title ?? t('capabilities.store.unnamedCatalog'),
    [registry.sources],
  );
  return { sources: registry.sources, sourceTitle };
}

/** A catalog's name, from every catalog the Account holds (a failed source may not serve this page's kind). */
export function useSourceTitle(): (sourceId: string) => string {
  return useSourceCatalog().sourceTitle;
}

function RegistryDirectory(
  props: Readonly<{
    kind: 'app' | 'starter' | 'browserExtension' | 'mcpServer' | 'skill';
    /** The row + verb when it is not Add (Starters: Start a project). */
    addLabel?: string;
    list: RegistryList;
    query: string;
    browsing: boolean;
    isAdded?: (item: RegistryCatalogItemSummary) => boolean;
    showEmptyState?: boolean;
    /** Narrows this page to one catalog: a long catalog section's All N ›. */
    onSeeSource?: (sourceId: string) => void;
  }>,
): React.ReactNode {
  const open = useOpenRegistryItem();
  const add = useAddRegistryItem();
  const openCategory = useOpenStoreCategory();
  const { sources, sourceTitle } = useSourceCatalog();
  const curated = React.useMemo(() => ({ items: props.list.items, curation: props.list.curation, sources,
    ...(props.browsing ? { curatedKind: props.kind } : {}) }), [props.list.items, props.list.curation, sources, props.browsing, props.kind]);
  const { rows, groups } = useRegistryRows(curated, open, sourceTitle, props.isAdded, add);
  const preview = useSourceSectionPreview(rows, groups, props.list, props.browsing ? props.onSeeSource : undefined);
  const groupAction = React.useCallback((groupKey: string): CollectionGroupAction | null => {
    const category = !props.query.trim() ? groups.find(group => group.key === groupKey)?.category : undefined;
    return category ? { label: t('capabilities.store.search.allOf', { count: category.total }), kind: 'link',
      onPress: () => openCategory(category.categoryId, category.catalogSourceId) } : preview.groupAction?.(groupKey) ?? null;
  }, [props.query, groups, openCategory, preview.groupAction]);
  return (
    <Directory
      kind={props.kind}
      {...(props.addLabel ? { addLabel: props.addLabel } : {})}
      rows={preview.rows}
      groups={groups}
      list={preview.list}
      query={props.query}
      sourceTitle={sourceTitle}
      showEmptyState={props.showEmptyState}
      groupAction={groupAction}
    />
  );
}

const registryReference = (item: RegistryCatalogItemSummary) => ({ type: 'registryItem' as const, kind: item.kind,
  sourceId: item.sourceId, itemId: item.itemId, ...(item.version ? { version: item.version } : {}) });

/**
 * A host that embeds this catalog list to pick one item (Deployments → Add a service or database) receives the
 * row's press and its + here, instead of the Store opening the listing. Absent, rows open as the Store does.
 */
export const StoreRegistryItemSelectContext = React.createContext<((item: RegistryCatalogItemSummary) => void) | null>(null);

/**
 * The App catalog as an embedded picker (Deployments → Add a service or database): the search with its conditions and
 * the catalog rows only, with no page header, project scope or listing pane. The host's conditions seed the picker's own
 * filter (a database category), and a row press or its + goes to `onSelect` instead of opening the listing.
 */
export function StoreRegistryItemPicker(props: Readonly<{
  presented: boolean;
  machine?: ReturnType<typeof useStoreMachineScope>;
  initialFilters?: SettingsCollectionFilter;
  onSelect: (item: RegistryCatalogItemSummary) => void;
  testID: string;
}>): React.ReactNode {
  const demand = React.useMemo(() => ({ presented: props.presented }), [props.presented]);
  return <StoreMachineScopeContext.Provider value={props.machine}>
  <StoreDiscover demand={demand} project={null} sections={REGISTRY_SOURCE_PROJECTION_SECTIONS}>{({ curation, complete }) =>
    <PickerQuery demand={demand} presented={props.presented} curation={curation.curation} curationComplete={complete}
      initialFilters={props.initialFilters} onSelect={props.onSelect} testID={props.testID} />
  }</StoreDiscover>
  </StoreMachineScopeContext.Provider>;
}

const PickerQuery = React.memo(function PickerQuery(props: Readonly<{ demand: Readonly<{ presented: boolean }>; presented: boolean;
  curation: RegistryCuration['curation']; curationComplete: boolean; initialFilters?: SettingsCollectionFilter;
  onSelect: (item: RegistryCatalogItemSummary) => void; testID: string }>) {
  const fields = useStoreFilterFields(props.curation, props.presented);
  const copy = kindCopy('app');
  return <StoreSearch kind="app" demand={props.demand} fields={fields} curation={props.curation}
    curationComplete={props.curationComplete} {...(props.initialFilters ? { initialFilters: props.initialFilters } : {})}>
    {state => {
      const visible = new Set(state.rows);
      const registryItems = state.rows.filter((row): row is RegistryCatalogItemSummary => 'kind' in row && 'itemId' in row);
      return (
        <StoreRegistryIdentityProvider items={registryItems}>
          <StoreRegistryItemSelectContext.Provider value={props.onSelect}>
            <View testID={props.testID}>
              <CompactSearchField placement="page" testID={`${props.testID}.search`} value={state.query}
                onChangeText={state.setQuery} placeholder={copy.search} trailing={state.filter.filterButton} />
              {state.filter.tokenRow ? <View style={styles.tokenRow}>{state.filter.tokenRow}</View> : null}
              {state.lists.app ? <RegistryDirectory kind="app" list={{ ...state.lists.app, curation: [...props.curation, ...state.lists.app.curation],
                items: state.lists.app.items.filter(item => visible.has(item)) }} query={state.query} browsing={false} />
                : <SkeletonRows testID={`${props.testID}.loading`} rows={5} accessibilityLabel={t('common.loading')} />}
            </View>
          </StoreRegistryItemSelectContext.Provider>
        </StoreRegistryIdentityProvider>
      );
    }}
  </StoreSearch>;
});

/** A row opens its exact listing (S40 §4.5): the pane beside the page, or its own page on a phone. */
export function useOpenRegistryItem(): (item: RegistryCatalogItemSummary) => void {
  const select = React.useContext(StoreRegistryItemSelectContext);
  const openListing = useOpenStoreListing();
  const open = React.useCallback((item: RegistryCatalogItemSummary) => openListing(registryReference(item)), [openListing]);
  return select ?? open;
}

/** The row's + adds through the Store's one open owner, seeded at this exact item. */
export function useAddRegistryItem(): (item: RegistryCatalogItemSummary) => void {
  const select = React.useContext(StoreRegistryItemSelectContext);
  const openReference = useStoreOpenReference();
  const add = React.useCallback((item: RegistryCatalogItemSummary) => openReference(registryReference(item)), [openReference]);
  return select ?? add;
}

/** The directory key of the selected listing, so the row its pane shows reads selected. */
export function directoryKeyOf(reference: StoreListingReference | null): string | null {
  if (reference?.type === 'pluginTheme') return JSON.stringify(['pluginTheme', reference.reference.pluginId, reference.reference.contributionId]);
  if (reference?.type === 'builtInPet') return `pet|builtIn|${reference.petId}`;
  return reference?.type === 'registryItem' ? `${reference.kind}|${reference.sourceId}|${reference.itemId}` : null;
}

/** The kind page's reading of `previewSourceSections` over its loaded catalog pages; a preview hides Load more, since nothing it loads would show. */
function useSourceSectionPreview<List extends Readonly<{ pages: readonly Readonly<{ sourceId: string; nextCursor: string | null }>[]; hasNextPage: boolean }>>(
  rows: readonly DirectoryRow[], groups: readonly DirectoryGroup[], list: List, onSeeSource: ((sourceId: string) => void) | undefined,
) {
  return React.useMemo(() => {
    const preview = previewSourceSections({ rows, groups, pages: list.pages, onSeeSource: onSeeSource ?? null });
    return { ...preview, list: preview.capped ? { ...list, hasNextPage: false } : list };
  }, [rows, groups, list, onSeeSource]);
}

function McpDirectory(props: Readonly<{ list: RegistryList; query: string; presented: boolean; browsing: boolean; onSeeSource: (sourceId: string) => void }>): React.ReactNode {
  const isAdded = useMcpAdded(props.presented);
  return <RegistryDirectory kind="mcpServer" list={props.list} query={props.query} browsing={props.browsing} isAdded={isAdded} onSeeSource={props.onSeeSource} />;
}

function SkillDirectory(props: Readonly<{ list: RegistryList; query: string; presented: boolean; browsing: boolean; onSeeSource: (sourceId: string) => void }>): React.ReactNode {
  const isAdded = useSkillAdded(props.presented);
  return <RegistryDirectory kind="skill" list={props.list} query={props.query} browsing={props.browsing} isAdded={isAdded} onSeeSource={props.onSeeSource} />;
}

/** The Agents built into Happier: each opens its own Settings page through the Store's open owner (nothing to add). */
export function useBuiltInAgentRows(items: StoreKindList<'agent'>['items']): readonly DirectoryRow[] {
  const openReference = useStoreOpenReference();
  return React.useMemo(
    () =>
      items
        .filter(
          (item): item is Exclude<StoreAgentItem, RegistryCatalogItemSummary> =>
            !('itemId' in item) && item.backendTargetKey !== null,
        )
        .map((entry): DirectoryRow => ({
          key: `agent|${entry.qualifiedId}`,
          title: entry.title,
          description: storeKinds.agent.summary(entry).description ?? null,
          group: 'builtIn',
          addable: false,
          open: () => openReference({ type: 'agentContribution', targetKey: entry.backendTargetKey! }),
          mark: (
            <StoreItemMark
              facts={{ kind: 'agent', title: entry.title, agentId: entry.iconAgentId ?? entry.catalogAgentId,
                bundledPluginId: entry.identity?.pluginId ?? null }}
              size={ROW_MARK_PX}
            />
          ),
        })),
    [openReference, items],
  );
}

function AgentDirectory(
  props: Readonly<{ list: StoreKindList<'agent'>; query: string; presented: boolean; browsing: boolean; onSeeSource: (sourceId: string) => void }>,
): React.ReactNode {
  const openRegistry = useOpenRegistryItem();
  const addRegistry = useAddRegistryItem();
  const sourceTitle = useSourceTitle();
  const isAdded = useAgentAdded(props.presented);
  const registryItems = React.useMemo(
    () =>
      props.list.items.filter(
        (item): item is RegistryCatalogItemSummary => 'itemId' in item,
      ),
    [props.list.items],
  );
  const registryList = React.useMemo(() => ({ items: registryItems, curation: props.list.curation,
    ...(props.browsing ? { curatedKind: 'agent' as const } : {}) }), [registryItems, props.list.curation, props.browsing]);
  const registry = useRegistryRows(
    registryList,
    openRegistry,
    sourceTitle,
    isAdded,
    addRegistry,
  );
  const builtIn = useBuiltInAgentRows(props.list.items);
  const rows = React.useMemo(
    () => [...builtIn, ...registry.rows],
    [builtIn, registry.rows],
  );
  const groups = React.useMemo(
    () => [
      ...(builtIn.length
        ? [
            {
              key: 'builtIn',
              title: t('capabilities.store.builtIn'),
              description: t('capabilities.store.builtInDescription'),
            },
          ]
        : []),
      ...registry.groups,
    ],
    [builtIn.length, registry.groups],
  );
  const preview = useSourceSectionPreview(rows, groups, props.list, props.browsing ? props.onSeeSource : undefined);
  return (
    <Directory
      kind="agent"
      rows={preview.rows}
      groups={groups}
      list={preview.list}
      query={props.query}
      sourceTitle={sourceTitle}
      {...(preview.groupAction ? { groupAction: preview.groupAction } : {})}
    />
  );
}

/** Provider rows: each opens its setup (the S20 hand-off); a contribution the Account already connected reads Added. */
export function useProviderRows(items: StoreKindList<'provider'>['items'], presented: boolean): readonly DirectoryRow[] {
  const openReference = useStoreOpenReference();
  const isAdded = useProviderAdded(presented);
  return React.useMemo(
    () =>
      items.map(
        (item: AccountProviderDeclarationV1): DirectoryRow => ({
          key: `provider|${item.contributionKey}`,
          title: item.definition.name,
          // Every Store row says what it is under its name; a Provider says its kind (the Providers settings' words).
          // The Store spans Machines: a local Provider runs on the person's Machines, not "this machine".
          description: item.definition.kind === 'local' ? t('capabilities.store.providerRunsOnMachines')
            : t(`settingsProviders.kind.${item.definition.kind}`),
          group: 'provider',
          added: isAdded(item.contributionKey),
          open: () => openReference({ type: 'providerContribution', contributionKey: item.contributionKey }),
          mark: (
            <StoreItemMark
              facts={{ kind: 'provider', title: item.definition.name, providerContributionKey: item.contributionKey,
                providerIcon: item.definition.icon }}
              size={ROW_MARK_PX}
            />
          ),
        }),
      ),
    [isAdded, openReference, items],
  );
}

function ProviderDirectory(
  props: Readonly<{ list: StoreKindList<'provider'>; query: string; presented: boolean }>,
): React.ReactNode {
  const rows = useProviderRows(props.list.items, props.presented);
  const groups = React.useMemo(() => [{ key: 'provider', title: '' }], []);
  return (
    <Directory
      kind="provider"
      rows={rows}
      groups={groups}
      list={props.list}
      query={props.query}
      sourceTitle={null}
    />
  );
}

export type DirectoryList = Readonly<{
  loading: boolean;
  error?: string | null;
  status?: RegistryFailureStatus | null;
  refresh?: () => void | Promise<void>;
  hasNextPage: boolean;
  nextPage?: () => Promise<void>;
  sourceFailures?: readonly Readonly<{
    sourceId: string | null;
    message?: string;
    status?: RegistryFailureStatus | null;
    onRetry: () => void | Promise<void>;
  }>[];
}>;

const keyOf = (row: DirectoryRow) => row.key;

export function Directory<Row extends DirectoryRow = DirectoryRow>(
  props: Readonly<{
    /** The kind page it belongs to, or `search` for the all-kind results. */
    kind: StoreDirectoryKind | 'search' | 'software' | 'bot';
    /** The row + verb when it is not Add (Software: Install on…). */
    addLabel?: string;
    /** The open row, for a page that holds its own listing (Software); otherwise the route's selection. */
    selectedKey?: string | null;
    /** The directory's accessible name (default: the kind page's title). */
    label?: string;
    /** Clears what narrows the rows; the no-match line offers it. */
    onClear?: () => void;
    /** Beside Load more: what the rows so far cover (a search over loaded pages). */
    moreNote?: string | null;
    rows: readonly Row[];
    /** Kind-owned anatomy uses this same directory's source states, selection and paging. */
    anatomy?: CollectionAnatomy<Row>;
    presentation?: 'list' | 'grid';
    /** Grid only: the kind's narrowest readable card (its own preview's proportions). */
    minCardWidth?: number;
    groups: readonly DirectoryGroup[];
    list: DirectoryList;
    query: string;
    sourceTitle: ((sourceId: string) => string) | null;
    /** A section's own trailing link (search's All N ›), beside its title. */
    groupAction?: (groupKey: string) => CollectionGroupAction | null;
    /** Contributed sections own their own empty results; native rows cannot describe the whole search. */
    showEmptyState?: boolean;
    /**
     * The directory is one titled section of its page (Bots: Shared with you, From the Store): its empty state is
     * this, and its catalogs' outage stays a line inside it, so neither becomes the page's state.
     */
    emptyState?: React.ReactNode;
  }>,
): React.ReactNode {
  const { rows } = props;
  const selection = useStoreListingSelection();
  const selectedKey = React.useMemo(() => {
    const key = props.selectedKey !== undefined ? props.selectedKey : directoryKeyOf(selection);
    return key !== null && rows.some((row) => row.key === key) ? key : null;
  }, [rows, selection, props.selectedKey]);
  // A kind page clears its own search, the route condition it reads.
  const directoryState = useStoreDirectoryState();
  const clearQuery = directoryState.setQuery;
  // The one catalog the route narrows to names a failed read that carries no source of its own.
  const narrowed = directoryState.state?.filters.source;
  const catalogId = narrowed?.include.length === 1 && narrowed.exclude.length === 0 ? narrowed.include[0]! : null;
  const anyCatalogTitle = useSourceTitle();
  const onClear = props.onClear ?? (() => clearQuery(''));
  const onOpenChange = React.useCallback(
    (key: string | null) => rows.find((row) => row.key === key)?.open(),
    [rows],
  );
  // A section titled by its page has no groups of its own.
  const grouping = React.useMemo(
    () => props.groups.length === 0 ? null : ({ axis: props.groups, groupOf: (row: Row) => row.group }),
    [props.groups],
  );
  const model = useHappierCollection<Row>({
    items: rows,
    keyOf,
    ...(grouping ? { groups: grouping } : {}),
    openKey: selectedKey,
    onOpenChange,
  });
  const addLabel = props.addLabel ?? t('capabilities.store.add');
  const onwardColor = useUnistyles().theme.colors.text.secondary;
  const anatomy = React.useMemo(
    (): CollectionAnatomy<Row> =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) => row.title,
        description: (row) => row.description,
        mark: (row) => row.mark,
        facts: (row) => row.facts ?? {},
        // The + is its own target: it opens the same Add owner the row does, never a second Add.
        // A row with nothing to add opens its own page: it points onward, as a navigation row does.
        action: (row) => row.addable === false ? (
          <Icon name="caret-right" size={ITEM_CHEVRON_SIZE.comfortable} color={onwardColor} />
        ) : (
          <RegistryShelfAddControl
            testID={`store.kind.${props.kind}.row.${row.key}`}
            state={row.added ? 'added' : 'available'}
            title={row.title}
            addLabel={row.addLabel ?? addLabel}
            addedLabel={t('capabilities.store.added')}
            failedLabel={t('capabilities.store.retry')}
            onAdd={row.add ?? row.open}
          />
        ),
        accessibilityLabel: (row) => row.title,
        testID: (row) => `store.kind.${props.kind}.row.${row.key}`,
      }),
    [addLabel, onwardColor, props.kind],
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const loadMore = props.list.nextPage;
  const onLoadMore = React.useCallback(async () => {
    if (!loadMore) return;
    setLoadingMore(true);
    try {
      await loadMore();
    } finally {
      setLoadingMore(false);
    }
  }, [loadMore]);
  // One line per failing catalog, however many kinds asked it. Across every kind (Search, Discover's shelves) a catalog
  // that waits for a Machine is not "Couldn't reach": its own kind page says what it needs.
  const sourceFailures = (props.list.sourceFailures ?? []).filter(failure => props.kind !== 'search' || failure.status?.state !== 'needs_machine');
  const readFailures = props.list.error && !props.list.loading && sourceFailures.length === 0 && props.list.refresh
    ? [{ sourceId: null, status: props.list.status ?? null, onRetry: props.list.refresh }] : [];
  const failures = [...sourceFailures, ...readFailures].filter((failure, index, all) =>
    all.findIndex((other) => other.sourceId === failure.sourceId) === index);
  const empty =
    !props.list.loading && rows.length === 0 && failures.length === 0;
  const section = props.emptyState !== undefined;
  // Every catalog failed and nothing is held: that failure is the page's state, said once.
  const pageFailure = !props.list.loading && rows.length === 0 && failures.length > 0 && props.showEmptyState !== false && !section;
  return (
    <View style={styles.body}>
      {/* Said once above the results (lab h:unreachable, as Discover does), so rows arriving later only ever land under it.
          On its page it stands a step clear of the search, as page status rather than the field's caption. */}
      {/* Under Discover's chip band (kind `search`) the band's own air leads it, as lab phone-lists-1115 S1 draws. */}
      {failures.length === 0 ? null : <View style={!section && !pageFailure && props.kind !== 'search' ? styles.pageStatus : null}>
      <RegistrySourcesUnavailable
        testID={`store.kind.${props.kind}.failure`}
        size={pageFailure ? 'page' : 'line'}
        // One owner for the words: "Couldn't reach {source}" (the failing catalog, else the one this page is
        // narrowed to, else the catalogs), with what the source said behind Details (the Plugins pattern).
        failures={failures.map((failure) => ({
          key: failure.sourceId ?? 'index',
          ...(failure.sourceId === null && !catalogId ? { allSources: true } : {}),
          ...registrySourceFailureLine(failure, failure.sourceId
            ? props.sourceTitle?.(failure.sourceId) ?? anyCatalogTitle(failure.sourceId) : catalogId ? anyCatalogTitle(catalogId) : null),
          onRetry: failure.onRetry,
        }))}
      />
      </View>}
      {empty && props.showEmptyState === false ? null : empty && props.query ? (
        // The same inline no-match state Installed uses: what found nothing, and the way to clear it.
        <EmptyState
          testID={`store.kind.${props.kind}.empty`}
          layout="inline"
          iconName="magnifying-glass"
          title={t('capabilities.store.noMatch', { query: props.query })}
          primaryAction={{ label: t('capabilities.store.clear'), onPress: onClear }}
        />
      ) : empty && section ? props.emptyState : empty ? (
        // Nothing around it: the page's own state, not a line waiting for rows that aren't there.
        <EmptyState
          testID={`store.kind.${props.kind}.empty`}
          layout="page"
          scene="noPlugins"
          title={t('capabilities.store.emptyTitle')}
          subtitle={t('capabilities.store.emptyBody')}
        />
      ) : pageFailure ? null : (
        <CoreCollectionScope renderPageScroller={passThroughScroller}>
          <Collection<Row>
            testID={`store.kind.${props.kind}.list`}
            model={model}
            anatomy={props.anatomy ?? anatomy}
            accessibilityLabel={
              props.label ?? (props.kind === 'search' ? '' : kindCopy(props.kind).title)
            }
            presentation={props.presentation ?? 'list'}
            {...(props.minCardWidth === undefined ? {} : { minCardWidth: props.minCardWidth })}
            detail="none"
            scroll="page-virtualized"
            minListWidth={280}
            minDetailWidth={280}
            preferredListRatio={1}
            loading={props.list.loading && rows.length === 0}
            {...(props.groupAction ? { groupAction: props.groupAction } : {})}
          />
        </CoreCollectionScope>
      )}
      {props.list.hasNextPage && loadMore ? (
        <View style={styles.more}>
          {props.moreNote ? (
            <Text variant="reading" style={styles.moreNote} testID={`store.kind.${props.kind}.moreNote`}>
              {props.moreNote}
            </Text>
          ) : null}
          <RoundButton
            testID={`store.kind.${props.kind}.loadMore`}
            size="small"
            display="secondary"
            title={t('capabilities.store.loadMore')}
            loading={loadingMore}
            onPress={() => {
              void onLoadMore();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The band's one filter row on a wide page: the catalog leads, the kind's either-or ends it, centred on one line.
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8 },
  filterRowEnd: { marginLeft: 'auto' },
  // No gap of its own: a state line hands over to the results' first section title, whose top air is the section
  // rhythm (lab phone-lists-1115 S1: line → "Apps" ~39); only Load more stands a step below the list.
  body: {},
  pageStatus: { paddingTop: theme.space.s12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  // In MainScreenHeader's band, which already stands on the sheets' edge: no second inset (OWNER-UI-1115B A1, chip under the title).
  phoneScope: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'center', marginBottom: theme.space.s8 },
  // On the page text edge with the section titles above it.
  more: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s12, marginTop: theme.space.s16,
    paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  moreNote: { color: theme.colors.text.secondary, flexShrink: 1 },
  // The condition chips stand on the search field's inset, not on the sheet's edge (VISUAL-136 D4).
  tokenRow: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
}));
