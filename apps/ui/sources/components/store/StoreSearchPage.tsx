import { rankByTitleMatch } from './catalog/storeSearchRank';
import * as React from 'react';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import type { CollectionGroupAction } from '@happier-dev/plugin-ui';
import { StoreProjectScopeChip } from './StoreProjectScopeChip';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { useRouter, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readStoreSoftwareTarget, readStoreListingReference } from '@/components/settings/plugins/model/storeListingSelection';
import type { StoreSoftwareTarget } from './catalog/storeSoftware';
import { SoftwareMark, SoftwareUnavailable } from './StoreSoftwarePage';
import { SoftwareMachineSelect, SoftwareTargetsDraftProvider, softwareMachineName, softwareMachinesUnreachableLine,
  useSoftwareMachines, type SoftwareMachineTarget } from './StoreSoftwareTargets';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import {
  buildPluginListingRoute,
  buildPluginsHomeRoute,
} from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { StoreBrowserExtensionLinkResult } from './StoreBrowserExtensionLinkResult';
import { readWebStoreExtensionId } from './catalog/storeBrowserExtensions';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { StoreItemMark } from './catalog/StoreItemMark';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

import type { StoreColumnField } from './catalog/storeColumnAdapter';
import { STORE_KIND_ORDER } from './catalog/storeKinds';
import { useStoreFilterFields } from './catalog/useStoreFilterFields';
import { StoreDirectoryUnavailable } from './StoreDirectoryUnavailable';
import { ContributedStoreKindSections, useContributedStoreKinds, selectContributedStoreKinds } from './StoreKindSurface';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { StoreDiscover } from './StoreDiscover';
import {
  Directory,
  kindCopy,
  useBuiltInAgentRows,
  useAddRegistryItem,
  useOpenRegistryItem,
  useProviderRows,
  useRegistryRows,
  useSourceCatalog,
  STORE_SECTION_PREVIEW_ROWS,
  type DirectoryGroup,
  type DirectoryList,
  type DirectoryRow,
} from './StoreKindPage';
import { useMcpAdded, useSkillAdded, useAgentAdded } from './catalog/storeAdded';
import { StoreDirectory, type StoreSearchState } from './StoreSearch';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { StoreListingPaneHost, useOpenStoreListing } from './StoreListing';
import { StoreRegistryIdentityProvider } from './catalog/StoreRegistryIdentity';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

/** Search reads in this order: the kinds people add most first, Plugins last (lab `h:search`). */
const KIND_ORDER = STORE_KIND_ORDER;
const ROW_MARK_PX = 26;
const NO_CURATION: RegistryCuration['curation'] = [];
const STATED_KIND: readonly StoreColumnField[] = ['kind'];

/**
 * Store search (`/plugins?view=search&q=…`, lab `h:search`, `hp:search`): the query and its conditions are the
 * route's (S40 §4.2), so Back and a phone push return to the same results. One shared condition owner
 * (`useSettingsColumnFilter` inside `StoreSearch`) narrows what each kind fetches and what the page shows; the
 * results are the kind pages' own catalog rows, one section per kind.
 */
export function StoreSearchPage(
  props: Readonly<{ presented: boolean }>,
): React.ReactNode {
  const params = useLocalSearchParams<{ softwareTarget?: string }>();
  const scope = useAccountSettingsScope();
  const softwareTarget = React.useMemo(() => {
    if (typeof params.softwareTarget === 'string') {
      try {
        const routed = readStoreSoftwareTarget(JSON.parse(params.softwareTarget));
        if (routed) return routed;
      } catch { /* An invalid route falls back to the Account's inert offerings. */ }
    }
    return { scope, machine: null };
  }, [params.softwareTarget, scope]);
  const demand = React.useMemo(
    () => ({ presented: props.presented }),
    [props.presented],
  );
  return (
    <SoftwareTargetsDraftProvider>
      <StoreDiscover demand={demand} project={null}>
        {({ curation, complete }) => (
          <SearchWithCuration
            demand={demand}
            curation={curation.curation}
            curationComplete={complete}
            presented={props.presented}
            softwareTarget={softwareTarget}
          />
        )}
      </StoreDiscover>
    </SoftwareTargetsDraftProvider>
  );
}

/** Reads only the admitted pages and their completeness: other curation publications leave Search still. */
const SearchWithCuration = React.memo(function SearchWithCuration(
  props: Readonly<{
    demand: Readonly<{ presented: boolean }>;
    curation: RegistryCuration['curation'];
    curationComplete: boolean;
    presented: boolean;
    softwareTarget: StoreSoftwareTarget | null;
  }>,
): React.ReactNode {
  const fields = useStoreFilterFields(props.curation, props.presented);
  // Wide pages state one chosen kind in the kind segment; the token row then says only the other conditions.
  const phone = !useAppShellColumn().columnVisible;
  const kindCondition = useStoreDirectoryState().state?.filters.kind;
  const kindStated = !phone && kindCondition?.include.length === 1 && kindCondition.exclude.length === 0;
  return (
    <StoreDirectory
      demand={props.demand}
      fields={fields}
      curation={props.curation}
      curationComplete={props.curationComplete}
      softwareTarget={props.softwareTarget}
      unavailable={<StoreDirectoryUnavailable view="search" />}
      {...(kindStated ? { statedFields: STATED_KIND } : {})}
    >
      {(state) => <SearchListing state={state} presented={props.presented} softwareTarget={props.softwareTarget} />}
    </StoreDirectory>
  );
});

function SearchListing(props: Readonly<{ state: StoreSearchState; presented: boolean; softwareTarget: StoreSoftwareTarget | null }>): React.ReactElement {
  const identities = React.useMemo(() => [
    ...props.state.rows.filter((row): row is RegistryCatalogItemSummary => 'kind' in row && 'itemId' in row),
    ...(props.state.lists.plugin?.items.flatMap(entry => entry.itemId ? [{ kind: 'plugin' as const,
      sourceId: entry.sourceId, itemId: entry.itemId, title: entry.title,
      ...(entry.version ? { version: entry.version } : {}) }] : []) ?? []),
  ], [props.state.rows, props.state.lists.plugin?.items]);
  return <StoreRegistryIdentityProvider items={identities}>
    <StoreListingPaneHost title={t('capabilities.store.discover.title')} testID="store.search">
      <SearchResults {...props} />
    </StoreListingPaneHost>
  </StoreRegistryIdentityProvider>;
}

function useGo(
  tag: string,
): (
  href: string | Parameters<ReturnType<typeof useRouter>['push']>[0],
) => void {
  const router = useRouter();
  return React.useCallback(
    (href) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true) fireAndForget(result, { tag });
    },
    [router, tag],
  );
}

type SearchSectionsInput = Readonly<{ state: StoreSearchState; presented: boolean; softwareTarget: StoreSoftwareTarget | null }>;

/** Every kind's rows from its own owners, sectioned for one directory: Search's results, and Discover's shelves when its curation is out. */
function useStoreSearchSections(props: SearchSectionsInput) {
  const { state } = props;
  const { lists, filter } = state;
  const allContributedKinds = useContributedStoreKinds();
  const contributedKinds = React.useMemo(() => selectContributedStoreKinds(allContributedKinds, filter.filters), [allContributedKinds, filter.filters]);
  const visible = React.useMemo(
    () => new Set<unknown>(state.rows),
    [state.rows],
  );

  // Each kind's rows, built by the kind pages' own owners (marks, Added state, the one open owner).
  const openRegistry = useOpenRegistryItem();
  const addRegistry = useAddRegistryItem();
  const openListing = useOpenStoreListing();
  const go = useGo('StoreSearchPage.plugin');
  const mcpAdded = useMcpAdded(props.presented);
  const skillAdded = useSkillAdded(props.presented);
  const agentAdded = useAgentAdded(props.presented);
  const { sources, sourceTitle } = useSourceCatalog();
  const pick = <Item,>(items: readonly Item[] | undefined): readonly Item[] =>
    (items ?? []).filter((item) => visible.has(item));
  const mcpItems = React.useMemo(
    () => pick(lists.mcpServer?.items),
    [lists.mcpServer?.items, visible],
  );
  const appItems = React.useMemo(() => pick(lists.app?.items), [lists.app?.items, visible]);
  const starterItems = React.useMemo(() => pick(lists.starter?.items), [lists.starter?.items, visible]);
  const browserExtensionItems = React.useMemo(() => pick(lists.browserExtension?.items), [lists.browserExtension?.items, visible]);
  const skillItems = React.useMemo(
    () => pick(lists.skill?.items),
    [lists.skill?.items, visible],
  );
  const agentItems = React.useMemo(
    () => pick(lists.agent?.items),
    [lists.agent?.items, visible],
  );
  const providerItems = React.useMemo(
    () => pick(lists.provider?.items),
    [lists.provider?.items, visible],
  );
  const pluginItems = React.useMemo(
    () => pick(lists.plugin?.items),
    [lists.plugin?.items, visible],
  );
  const registryAgents = React.useMemo(
    () =>
      agentItems.filter(
        (item): item is RegistryCatalogItemSummary => 'itemId' in item,
      ),
    [agentItems],
  );
  const mcp = useRegistryRows(
    { items: mcpItems, curation: NO_CURATION },
    openRegistry,
    sourceTitle,
    mcpAdded,
    addRegistry,
  );
  const app = useRegistryRows({ items: appItems, curation: NO_CURATION, sources }, openRegistry, sourceTitle, undefined, addRegistry);
  const starterRows = useRegistryRows({ items: starterItems, curation: NO_CURATION, sources }, openRegistry, sourceTitle, undefined, addRegistry);
  // A starter's + starts a project from it, as on its kind page.
  const starter = React.useMemo(() => starterRows.rows.map((row): DirectoryRow => ({ ...row, addLabel: t('capabilities.store.startProject') })), [starterRows.rows]);
  const browserExtension = useRegistryRows({ items: browserExtensionItems, curation: NO_CURATION }, openRegistry, sourceTitle, undefined, addRegistry);
  const skill = useRegistryRows(
    { items: skillItems, curation: NO_CURATION },
    openRegistry,
    sourceTitle,
    skillAdded,
    addRegistry,
  );
  const agent = useRegistryRows(
    { items: registryAgents, curation: NO_CURATION },
    openRegistry,
    sourceTitle,
    agentAdded,
    addRegistry,
  );
  const builtIn = useBuiltInAgentRows(agentItems);
  const providers = useProviderRows(providerItems, props.presented);
  const plugins = React.useMemo(
    () =>
      pluginItems.map((entry): DirectoryRow => ({
        key: `plugin|${entry.sourceId}|${entry.itemId ?? entry.id}`,
        title: entry.title,
        description: entry.description,
        group: 'plugin',
        // A plugin's listing is the existing Plugins listing (its review and Install & Trust stay there): beside the
        // page when the catalog names its exact item, else the legacy listing page.
        open: () => entry.itemId
          ? openListing({ type: 'registryItem', kind: 'plugin', sourceId: entry.sourceId, itemId: entry.itemId,
            ...(entry.version ? { version: entry.version } : {}) })
          : go(
            buildPluginListingRoute('app', {
              sourceId: entry.sourceId,
              pluginId: entry.id,
              ...(entry.itemId ? { itemId: entry.itemId } : {}),
              ...(entry.version ? { version: entry.version } : {}),
            }),
          ),
        mark: <StoreItemMark facts={{ kind: 'plugin', title: entry.title }} size={ROW_MARK_PX} />,
      })),
    [go, openListing, pluginItems],
  );
  const software = React.useMemo(() => pick(lists.software?.items).map((item): DirectoryRow => ({
    key: actionInputOptionValueKey(item.value), title: item.label, description: item.description ?? null, group: 'software',
    open: () => {
      const reference = readStoreListingReference({ type: 'software',
        ...(props.softwareTarget?.machine ? { target: props.softwareTarget } : {}), value: item.value });
      if (reference) openListing(reference);
    },
    addLabel: t('capabilities.store.softwarePage.installOn'),
    mark: <SoftwareMark item={item} pixelSize={ROW_MARK_PX} />,
  })), [lists.software?.items, visible, props.softwareTarget, openListing]);

  const byKind: Readonly<Record<typeof KIND_ORDER[number], readonly DirectoryRow[]>> =
    React.useMemo(
      () => ({
        app: rankByTitleMatch(app.rows, state.query),
        starter: rankByTitleMatch(starter, state.query),
        browserExtension: rankByTitleMatch(browserExtension.rows, state.query),
        mcpServer: rankByTitleMatch(mcp.rows, state.query),
        skill: rankByTitleMatch(skill.rows, state.query),
        agent: rankByTitleMatch([...builtIn, ...agent.rows], state.query),
        provider: rankByTitleMatch(providers, state.query),
        plugin: rankByTitleMatch(plugins, state.query),
        software: rankByTitleMatch(software, state.query),
      }),
      [app.rows, starter, browserExtension.rows, agent.rows, builtIn, mcp.rows, plugins, providers, skill.rows, software, state.query],
    );
  const sections = KIND_ORDER.filter((kind) => byKind[kind].length > 0);
  const selectedKind =
    filter.filters.kind?.include.length === 1 &&
    filter.filters.kind.exclude.length === 0
      ? filter.filters.kind.include[0]!
      : 'all';
  const setFilters = filter.setFilters;
  const setKind = React.useCallback((kind: string) =>
    setFilters((filters) => {
      const { kind: _kind, ...rest } = filters;
      return kind === 'all'
        ? rest
        : { ...rest, kind: { include: [kind], exclude: [] } };
    }), [setFilters]);
  // A kind's total is known only when its source has nothing more to page (S40 §4.4: never drain cursors to count).
  // A kind whose catalog didn't answer has no total either: its 0 would claim confirmed-empty for an unknown.
  const totalKnown = (kind: typeof KIND_ORDER[number]) => {
    const list = lists[kind];
    if (list?.hasNextPage === true) return false;
    if (!list) return true;
    return !('error' in list && list.error) && !('sourceFailures' in list && list.sourceFailures.length > 0);
  };
  // All kinds at once shows where the matches are: each kind previews its first rows and keeps the rest behind its
  // own All N › (lab h:search). One chosen kind shows every row.
  const preview = selectedKind === 'all' && sections.length > 1;
  // Section by kind: a search's results never repeat the kind word inside its own section.
  const rows = React.useMemo(
    () =>
      sections.flatMap((kind) =>
        (preview ? byKind[kind].slice(0, STORE_SECTION_PREVIEW_ROWS) : byKind[kind]).map((row) => ({ ...row, group: kind })),
      ),
    [byKind, preview, sections.join('|')],
  );
  const knownKinds = KIND_ORDER.filter(totalKnown).join('|');
  const groupAction = React.useCallback((groupKey: string): CollectionGroupAction | null => {
    const kind = KIND_ORDER.find((candidate) => candidate === groupKey);
    if (!kind) return null;
    const known = knownKinds.split('|').includes(kind);
    if (known && byKind[kind].length <= STORE_SECTION_PREVIEW_ROWS) return null;
    return {
      label: known ? t('capabilities.store.search.allOf', { count: byKind[kind].length }) : t('capabilities.store.search.all'),
      onPress: () => setKind(kind),
      kind: 'link',
    };
  }, [byKind, knownKinds, setKind]);
  const groups = React.useMemo(
    (): readonly DirectoryGroup[] =>
      sections.map((kind) => ({ key: kind, title: kindCopy(kind).title })),
    [sections.join('|')],
  );

  // One Load more for the whole search; each kind keeps its own continuation and failures.
  const continuations = KIND_ORDER.flatMap((kind) => {
    const list = lists[kind];
    return list && list.hasNextPage && 'nextPage' in list && list.nextPage
      ? [list.nextPage]
      : [];
  });
  const loading = KIND_ORDER.some((kind) => lists[kind]?.loading === true);
  const catalogs = KIND_ORDER.flatMap(kind => {
    const list = lists[kind];
    return list && ('sourceFailures' in list || 'sourceStatuses' in list) ? [list] : [];
  });
  const failures = catalogs.flatMap(list => 'sourceFailures' in list ? list.sourceFailures : []);
  const failedReads = catalogs.flatMap(list => list.error && !list.loading
    && (!('sourceFailures' in list) || list.sourceFailures.length === 0)
      ? [{ status: 'status' in list ? list.status : null, retry: list.refresh }] : []);
  // Every kind publishes loading and then its value on each query, about ten commits per keystroke. The directory
  // reads only what the lines say, so the list keeps its identity until one of them changes; the actions read the
  // current kinds through a render-synced handle instead of being rebuilt with every publication.
  const current = React.useRef({ continuations, failures, failedReads });
  current.current = { continuations, failures, failedReads };
  const nextPage = React.useCallback(async () => {
    await Promise.all(current.current.continuations.map((next) => next()));
  }, []);
  const failureLines = [...failures.map((failure) => [failure.sourceId, failure.status ?? null, failure.message ?? null]),
    ...(failedReads.length ? [[null, failedReads[0]!.status ?? null, null]] : [])];
  const failureSignature = JSON.stringify(failureLines);
  const sourceFailures = React.useMemo((): NonNullable<DirectoryList['sourceFailures']> => {
    const { failures: named, failedReads: unnamed } = current.current;
    return [
      ...named.map((failure, index) => ({ sourceId: failure.sourceId, status: failure.status, message: failure.message,
        onRetry: () => current.current.failures[index]?.onRetry() })),
      // Reads that failed without naming a catalog are one "Couldn't reach the catalogs" line.
      ...(unnamed.length ? [{ sourceId: null, status: unnamed[0]!.status,
        onRetry: async () => { await Promise.all(current.current.failedReads.map(failure => failure.retry())); } }] : []),
    ];
  }, [failureSignature]);
  const hasNextPage = continuations.length > 0;
  const list = React.useMemo((): DirectoryList => ({ loading, hasNextPage, nextPage, sourceFailures }),
    [loading, hasNextPage, nextPage, sourceFailures]);

  const count = sections.reduce((sum, kind) => sum + byKind[kind].length, 0);
  return { allContributedKinds, contributedKinds, byKind, sections, selectedKind, setKind, totalKnown, preview, rows, groups,
    groupAction, list, loading, count, sourceTitle };
}

/**
 * Discover while its curated catalogs are out (lab h:unreachable, "everything else is here"): every healthy catalog and
 * built-in, each kind previewing its first rows with All N › to its kind page. The same rows and directory as Search.
 */
export function StoreCatalogShelves(props: SearchSectionsInput & Readonly<{
  onOpenKind: (kind: string) => void;
  /** The curated sources that failed too: the page says every outage on this one line (lab h:unreachable). */
  curationFailures: NonNullable<DirectoryList['sourceFailures']>;
}>): React.ReactNode {
  const { sections, groups, list, byKind, sourceTitle } = useStoreSearchSections(props);
  // Shelves always preview, even when one kind is all that answered; its All › opens the whole kind.
  const rows = sections.flatMap((kind) => byKind[kind].slice(0, STORE_SECTION_PREVIEW_ROWS).map((row) => ({ ...row, group: kind })));
  const { onOpenKind, curationFailures } = props;
  const groupAction = React.useCallback((groupKey: string): CollectionGroupAction | null => {
    const kind = KIND_ORDER.find((candidate) => candidate === groupKey);
    return kind ? { label: t('capabilities.store.discover.all'), onPress: () => onOpenKind(kind), kind: 'link' } : null;
  }, [onOpenKind]);
  // One outage line for the page: the curated sources and the other named catalogs together (the Directory keeps one
  // entry per catalog). A read that failed without naming a catalog is that same outage reaching it: it adds nothing
  // when a catalog is named, and is the line itself when none is. Shelves preview; each kind's All › pages the rest,
  // so there is no Load more here.
  const failures = [...curationFailures, ...(list.sourceFailures ?? [])];
  const named = failures.filter(failure => failure.sourceId !== null);
  const shown: DirectoryList = { ...list, hasNextPage: false, sourceFailures: named.length > 0 ? named : failures.slice(0, 1) };
  if (Object.values(byKind).every(kindRows => kindRows.length === 0) && !list.loading && shown.sourceFailures!.length === 0) return null;
  return (
    <Directory kind="search" label={t('capabilities.store.discover.title')} rows={rows} groups={groups} list={shown}
      query="" sourceTitle={sourceTitle} showEmptyState={false} groupAction={groupAction} />
  );
}


/** Kinds narrow what is fetched before it is fetched; the pills change only with the chosen kind or the contributed kinds. */
const SearchKindBar = React.memo(function SearchKindBar(props: Readonly<{
  selectedKind: string;
  setKind: (kind: string) => void;
  contributedKinds: ReturnType<typeof useContributedStoreKinds>;
}>): React.ReactNode {
  const localize = useProjectedPluginLocalizedTextResolver();
  return (
    <View style={[styles.inset, styles.kinds]}>
      <SegmentedTabBar<string>
        role="radiogroup"
        // Seven kinds are a list filter, not a 2–4 segment choice: separate pills, each with what it found.
        presentation="pills"
        // A narrow page (a pane beside it) shows the kinds as one field select instead of wrapping them.
        overflow={{ label: t('common.more') }}
        segmentSizing="content"
        accessibilityLabel={t('capabilities.store.search.kind')}
        activeTabId={props.selectedKind}
        tabs={[
          {
            id: 'all',
            label: t('capabilities.store.search.all'),
            testID: 'store.search.kind.all',
          },
          ...KIND_ORDER.map((kind) => ({
            id: kind,
            label: kindCopy(kind).title,
            // No counts on the kinds: only some kinds can know theirs (paged or unreached catalogs can't), and a
            // count on just those reads as a fact about the others. The field says how many matched; each
            // section's All N › says its own.
            testID: `store.search.kind.${kind}`,
          })),
          ...props.contributedKinds.map(kind => ({ id: kind.key,
            label: localize(kind.pluginId, kind.definition.title), testID: `store.search.kind.${kind.key}` })),
        ]}
        onSelectTab={props.setKind}
      />
    </View>
  );
});

/** The results re-render when what they show changes, not on every kind's loading publication. */
const SearchDirectory = React.memo(Directory);

function SearchResults(
  props: SearchSectionsInput,
): React.ReactNode {
  const { state } = props;
  const { lists, filter } = state;
  const { allContributedKinds, contributedKinds, selectedKind, setKind, preview, rows, groups,
    groupAction, list, loading, count, sourceTitle } = useStoreSearchSections(props);
  const phone = !useAppShellColumn().columnVisible;
  const query = state.query.trim();
  // A warm read changes activity, not what the held rows cover or the page's height.
  const partial = filter.result.coverage === 'partial' && count > 0;
  const { setQuery } = state;
  const { clearFilters } = filter;
  const clearAll = React.useCallback(() => {
    setQuery('');
    clearFilters();
  }, [setQuery, clearFilters]);

  return (
    <ItemList pageColumn="wide" testID="store.search">
      <PageContentColumn>
        {/* The main-screen head every main page draws (ruling 11-13). The Store is search-first: its field arrives
            open (unfocused); the funnel ends it, the result count reports under it, and kinds and conditions narrow it. */}
        <View ref={filter.searchAnchorRef as never}>
          <MainScreenHeader
            testID="store.search.header"
            title={t('capabilities.store.discover.title')}
            description={t('capabilities.store.discover.purpose')}
            actions={<StoreProjectScopeChip />}
            search={{
              value: state.query,
              onChangeText: state.setQuery,
              placeholder: t(phone ? 'capabilities.store.discover.searchShort' : 'capabilities.store.discover.search'),
              testID: 'store.search.field',
              ...(filter.filterButton ? { trailing: filter.filterButton } : {}),
            }}
            band={!phone || filter.tokenRow ? <>
              {/* Kinds narrow what is fetched before it is fetched; a phone reaches the same choice in the filter editor. */}
              {phone ? null : <SearchKindBar selectedKind={selectedKind} setKind={setKind} contributedKinds={allContributedKinds} />}
              {filter.tokenRow ?? null}
            </> : undefined}
            status={query.length > 0 && !loading && count > 0 ? (
              <Text variant="meta" style={styles.count} testID="store.search.count">
                {t('capabilities.store.search.results', { count })}
              </Text>
            ) : undefined}
          />
        </View>
        {/* The Machine chooser narrows Software results: it stands only where Software is asked for, found, or failed to load. */}
        {lists.software && (selectedKind === 'software' || lists.software.items.length > 0 || !!lists.software.error)
          ? <SoftwareSource list={lists.software} target={props.softwareTarget} /> : null}
        {/* A pasted Chrome Web Store link or ID is one result: install that extension. */}
        {selectedKind === 'all' || selectedKind === 'browserExtension' ? <StoreBrowserExtensionLinkResult query={query} /> : null}
        <SearchDirectory
          kind="search"
          label={t('capabilities.store.discover.title')}
          rows={rows}
          groups={groups}
          list={list}
          query={query || filter.conditionWords}
          onClear={clearAll}
          moreNote={partial ? t('capabilities.store.search.partial') : null}
          sourceTitle={sourceTitle}
          showEmptyState={contributedKinds.length === 0 && readWebStoreExtensionId(query) === null}
          {...(preview ? { groupAction } : {})}
        />
        <ContributedStoreKindSections kinds={contributedKinds} mode="search" presented={props.presented} query={query} filters={filter.filters} />
        {filter.editorOverlay}
      </PageContentColumn>
    </ItemList>
  );
}

/**
 * An optional Machine narrows the Account's inert offerings to its supported Software. The route owns that choice;
 * a chosen Machine that can't be read says why.
 */
function SoftwareSource(props: Readonly<{
  list: NonNullable<StoreSearchState['lists']['software']>;
  target: StoreSoftwareTarget | null;
}>): React.ReactNode {
  const router = useRouter();
  const machines = useSoftwareMachines();
  const choose = React.useCallback((entry: SoftwareMachineTarget) => {
    const result = runGuardedNavigation(() => router.setParams({ softwareTarget: JSON.stringify(entry.target) }));
    if (result !== true) fireAndForget(result, { tag: 'StoreSearchPage.softwareTarget' });
  }, [router]);
  const selectedId = props.target?.machine?.machineId ?? null;
  const chosen = machines.targets.find((entry) => entry.machine.machineId === selectedId) ?? null;
  if (machines.targets.length === 0) {
    return props.list.error ? <SoftwareUnavailable error={props.list.error} onRetry={props.list.refresh} /> : null;
  }
  // No Machine can be chosen now: say why once, instead of a chooser whose every choice is disabled.
  const unreachable = softwareMachinesUnreachableLine(machines);
  if (unreachable) {
    return <SurfaceStateCard testID="store.search.software.unreachable" kind="unavailable" size="line" title={unreachable} />;
  }
  return (
    <>
      <View style={[styles.inset, styles.source]} testID="store.search.software.source">
        <Text variant="meta" style={styles.sourceLabel}>{t('capabilities.store.softwarePage.searchFrom')}</Text>
        <SoftwareMachineSelect
          testID="store.search.software.machine"
          machines={machines}
          selectedId={chosen ? selectedId : null}
          onSelect={choose}
          placeholder={t('capabilities.store.softwarePage.chooseMachine')}
        />
      </View>
      {chosen && props.list.error ? (
        <SoftwareUnavailable error={props.list.error} machine={softwareMachineName(chosen.machine)}
          onRetry={props.list.refresh} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A condition of the search, a step under the kinds it qualifies.
  source: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexWrap: 'wrap', marginTop: theme.space.s8 },
  sourceLabel: { color: theme.colors.text.secondary },
  inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  // A changing count keeps its width per digit.
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  // The kinds sit a step under the search they narrow (lab h:search chips).
  kinds: { marginTop: theme.space.s12, alignItems: 'flex-start' },
}));
