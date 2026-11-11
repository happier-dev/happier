import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { HappierCapabilityFactsInput } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
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
import { HAPPIER_PICKS_SOURCE_ID, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';

import { RegistryShelfAddControl } from '@/components/capabilities/add/RegistryShelf';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { EmptyState } from '@/components/ui/empty/EmptyState';
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
import { useStoreOpenReference } from './catalog/useStoreOpenReference';
import { StoreItemMark } from './catalog/StoreItemMark';
import { hydrateStoreRegistryIdentity, StoreRegistryIdentityProvider } from './catalog/StoreRegistryIdentity';
import { StoreListingPaneHost, useOpenStoreListing, useStoreListingSelection } from './StoreListing';
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
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { StoreMachineScopeContext, type useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';

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
}>;
export type DirectoryGroup = Readonly<{
  key: string;
  title: string;
  description?: string;
}>;

/** A Store kind page (lab `h:apps`, translated per kind): header, search with its catalog, then sections of catalog rows. */
export function StoreKindPage(
  props: Readonly<{ kind: StoreDirectoryKind; presented: boolean }>,
): React.ReactNode {
  const demand = React.useMemo(() => ({ presented: props.presented }), [props.presented]);
  return <StoreDiscover demand={demand} project={null}>{({ curation, complete }) =>
    <KindQuery {...props} demand={demand} curation={curation.curation} curationComplete={complete}
      curationRead={curation.layout} />
  }</StoreDiscover>;
}

/** Reads admitted editorial pages and their stable layout state; other catalog publications leave the page still. */
const KindQuery = React.memo(function KindQuery(props: Readonly<{ kind: StoreDirectoryKind; presented: boolean;
  demand: Readonly<{ presented: boolean }>; curation: RegistryCuration['curation']; curationComplete: boolean; curationRead: RegistryCuration['layout'] }>) {
  const fields = useStoreFilterFields(props.curation, props.presented);
  return <StoreQueryDirectory kind={props.kind} demand={props.demand} fields={fields}
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
  const browsing = !state.query.trim() && Object.keys(filter.filters).length === 0;
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
  if (kindPageWaitsForCuration({ browsing, kind: props.kind, curationRead: props.curationRead, settled: curationSettled.current })) return frame(
    <SkeletonRows testID={`store.kind.${props.kind}.loading`} rows={5} accessibilityLabel={t('common.loading')} />);
  switch (props.kind) {
    case 'browserExtension':
      // A pasted Chrome Web Store link or ID installs that extension, whether or not the catalog lists it or is reachable.
      return frame(<><StoreBrowserExtensionLinkResult query={state.query} />{state.lists.browserExtension
        ? <RegistryDirectory kind="browserExtension" list={{ ...state.lists.browserExtension, curation: props.curation,
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.browserExtension.sourceFailures],
          items: state.lists.browserExtension.items.filter(item => visible.has(item)) }} query={state.query} browsing={browsing} onSeeSource={setSourceId}
          showEmptyState={readWebStoreExtensionId(state.query) === null} />
        : <Directory kind={props.kind} rows={[]} groups={[]} list={{ loading: false, hasNextPage: false }} query={state.query} sourceTitle={null}
          showEmptyState={readWebStoreExtensionId(state.query) === null} />}</>);
    case 'starter':
      if (state.lists.starter) return frame(<RegistryDirectory kind="starter" addLabel={t('capabilities.store.startProject')} list={{ ...state.lists.starter, curation: props.curation,
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.starter.sourceFailures],
          items: state.lists.starter.items.filter(item => visible.has(item)) }} query={state.query} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'app':
      if (state.lists.app) return frame(<RegistryDirectory kind="app" list={{ ...state.lists.app, curation: props.curation,
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.app.sourceFailures],
        items: state.lists.app.items.filter(item => visible.has(item)) }} query={state.query} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'mcpServer':
      if (state.lists.mcpServer) return frame(<McpDirectory list={{ ...state.lists.mcpServer, curation: props.curation,
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.mcpServer.sourceFailures],
        items: state.lists.mcpServer.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'skill':
      if (state.lists.skill) return frame(<SkillDirectory list={{ ...state.lists.skill, curation: props.curation,
          sourceFailures: [...props.curationRead.sourceFailures, ...state.lists.skill.sourceFailures],
        items: state.lists.skill.items.filter(item => visible.has(item)) }} query={state.query} presented={props.presented} browsing={browsing} onSeeSource={setSourceId} />);
      break;
    case 'agent':
      if (state.lists.agent) return frame(<AgentDirectory list={{ ...state.lists.agent, curation: props.curation,
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
  const registrySelect = registryKind && props.onSourceChange ? (
    <CatalogSelect
      kind={registryKind}
      presented={props.presented}
      sourceId={props.sourceId ?? null}
      onSourceChange={props.onSourceChange}
    />
  ) : undefined;
  const accessory = props.accessory ?? registrySelect;
  // Software reads one Machine and Bot templates belong to no project, so a project scope has nothing to narrow there.
  const scoped = props.kind !== 'software' && props.kind !== 'bot';
  return (
    <StoreListingPaneHost title={copy.title} testID={`store.kind.${props.kind}`}>
    <ItemList pageColumn="wide" testID={`store.kind.${props.kind}`}>
      <PageContentColumn>
        {/* A phone's description keeps the line's width; the scope chip stands under it, as on Discover (TASTE-S4060 D8). */}
        {/* A phone's bar names the kind, with Back when the kind was opened from the Store (lab wp/kind); the body keeps the purpose line. */}
        <PageHeader title={copy.title} description={copy.description} {...(stacked || !scoped ? {} : { actions: props.kind === 'app'
          ? <View style={styles.headerActions}><StoreAppDefinitionEntries /><StoreProjectScopeChip /></View> : <StoreProjectScopeChip />, actionsPlacement: 'page' as const })} />
        {/* Everything that says what the page shows stands on one line; the search keeps its own. */}
        {stacked ? <View style={styles.phoneScope}>{scoped ? <StoreProjectScopeChip /> : null}{accessory}{props.kind === 'app' ? <StoreAppDefinitionEntries /> : null}</View> : null}
        <CompactSearchField
          placement="page"
          testID={`store.kind.${props.kind}.search`}
          value={props.query}
          onChangeText={props.onQueryChange}
          placeholder={copy.search}
          trailing={props.filter?.filterButton}
          {...(stacked ? {} : { accessory })}
        />
        {props.filter?.tokenRow}
        {props.children}
      </PageContentColumn>
    </ItemList>
    </StoreListingPaneHost>
  );
}

/** Only registry-backed kinds choose a catalog (S40 §5); it narrows remote demand before fetching. */
function CatalogSelect(
  props: Readonly<{
    kind: 'app' | 'mcpServer' | 'skill' | 'agent' | 'browserExtension' | 'plugin';
    presented: boolean;
    sourceId: string | null;
    onSourceChange: (sourceId: string | null) => void;
  }>,
): React.ReactNode {
  const registry = useRegistrySources(props.kind, props.presented);
  const sources = registry.sources.filter((source) => source.enabled);
  // Held in place while the catalogs load, so the search beside it never changes width on arrival.
  if (registry.hasValue && sources.length < 2) return null;
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
      disabled: !registry.hasValue,
    }} />
  );
}

type RegistryList = StoreKindList<'mcpServer'>;

export function kindCopy(kind: StoreDirectoryKind | 'plugin' | 'software' | 'bot'): Readonly<{ title: string; description: string; search: string }> {
    switch (kind) {
        case 'bot': return { title: t('bots.title'), description: t('botTemplates.storeDescription'), search: t('botTemplates.storeSearch') };
        case 'app': return { title: t('capabilities.store.kinds.app.title'), description: t('capabilities.store.kinds.app.description'), search: t('capabilities.store.kinds.app.search') };
        case 'starter': return { title: t('capabilities.store.kinds.starter.title'), description: t('capabilities.store.kinds.starter.description'), search: t('capabilities.store.kinds.starter.search') };
        case 'browserExtension': return { title: t('capabilities.store.kinds.browserExtension.title'), description: t('capabilities.store.kinds.browserExtension.description'), search: t('capabilities.store.kinds.browserExtension.search') };
        case 'software': return { title: t('capabilities.store.kinds.software.title'), description: t('capabilities.store.softwarePage.description'), search: t('capabilities.store.softwarePage.search') };
        case 'mcpServer': return { title: t('capabilities.store.kinds.mcpServer.title'), description: t('capabilities.store.kinds.mcpServer.description'), search: t('capabilities.store.kinds.mcpServer.search') };
        case 'skill': return { title: t('capabilities.store.kinds.skill.title'), description: t('capabilities.store.kinds.skill.description'), search: t('capabilities.store.kinds.skill.search') };
        case 'agent': return { title: t('capabilities.store.kinds.agent.title'), description: t('capabilities.store.kinds.agent.description'), search: t('capabilities.store.kinds.agent.search') };
        case 'provider': return { title: t('capabilities.store.kinds.provider.title'), description: t('capabilities.store.kinds.provider.description'), search: t('capabilities.store.kinds.provider.search') };
        case 'plugin': return { title: t('capabilities.store.kinds.plugin.title'), description: t('capabilities.store.kinds.plugin.description'), search: t('capabilities.store.kinds.plugin.search') };
    }
}

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
      Readonly<{ title: string; description?: string; members: Set<string> }>
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
          members,
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
        && group.title === orderedGroups[index]!.title && group.description === orderedGroups[index]!.description);
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
  const { sources, sourceTitle } = useSourceCatalog();
  const curated = React.useMemo(() => ({ items: props.list.items, curation: props.list.curation, sources,
    ...(props.browsing ? { curatedKind: props.kind } : {}) }), [props.list.items, props.list.curation, sources, props.browsing, props.kind]);
  const { rows, groups } = useRegistryRows(curated, open, sourceTitle, props.isAdded, add);
  const preview = useSourceSectionPreview(rows, groups, props.list, props.browsing ? props.onSeeSource : undefined);
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
      {...(preview.groupAction ? { groupAction: preview.groupAction } : {})}
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
  <StoreDiscover demand={demand} project={null}>{({ curation, complete }) =>
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
              {state.filter.tokenRow}
              {state.lists.app ? <RegistryDirectory kind="app" list={{ ...state.lists.app, curation: props.curation,
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

export function Directory(
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
    rows: readonly DirectoryRow[];
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
    () => props.groups.length === 0 ? null : ({ axis: props.groups, groupOf: (row: DirectoryRow) => row.group }),
    [props.groups],
  );
  const model = useHappierCollection<DirectoryRow>({
    items: rows,
    keyOf,
    ...(grouping ? { groups: grouping } : {}),
    openKey: selectedKey,
    onOpenChange,
  });
  const addLabel = props.addLabel ?? t('capabilities.store.add');
  const onwardColor = useUnistyles().theme.colors.text.secondary;
  const anatomy = React.useMemo(
    (): CollectionAnatomy<DirectoryRow> =>
      buildCapabilityCollectionAnatomy<DirectoryRow>({
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
  // One line per failing catalog, however many kinds asked it.
  const sourceFailures = props.list.sourceFailures ?? [];
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
      {failures.length === 0 ? null : <View style={!section && !pageFailure ? styles.pageStatus : null}>
      <RegistrySourcesUnavailable
        testID={`store.kind.${props.kind}.failure`}
        size={pageFailure ? 'page' : 'line'}
        // One owner for the words: "Couldn't reach {source}" (the failing catalog, else the one this page is
        // narrowed to, else the catalogs), with what the source said behind Details (the Plugins pattern).
        failures={failures.map((failure) => ({
          key: failure.sourceId ?? 'index',
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
          <Collection<DirectoryRow>
            testID={`store.kind.${props.kind}.list`}
            model={model}
            anatomy={anatomy}
            accessibilityLabel={
              props.label ?? (props.kind === 'search' ? '' : kindCopy(props.kind).title)
            }
            presentation="list"
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
  body: { gap: theme.space.s16 },
  pageStatus: { paddingTop: theme.space.s12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  phoneScope: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'center', paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(), marginBottom: theme.space.s8 },
  // On the page text edge with the section titles above it.
  more: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s12,
    paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  moreNote: { color: theme.colors.text.secondary, flexShrink: 1 },
}));
