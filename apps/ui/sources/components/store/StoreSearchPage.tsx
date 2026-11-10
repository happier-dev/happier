import { rankByTitleMatch } from './catalog/storeSearchRank';
import * as React from 'react';
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
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { StoreBrowserExtensionLinkResult } from './StoreBrowserExtensionLinkResult';
import { readWebStoreExtensionId } from './catalog/storeBrowserExtensions';
import { PageHeader } from '@/components/ui/layout/PageHeader';
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
        browserExtension: rankByTitleMatch(browserExtension.rows, state.query),
        mcpServer: rankByTitleMatch(mcp.rows, state.query),
        skill: rankByTitleMatch(skill.rows, state.query),
        agent: rankByTitleMatch([...builtIn, ...agent.rows], state.query),
        provider: rankByTitleMatch(providers, state.query),
        plugin: rankByTitleMatch(plugins, state.query),
        software: rankByTitleMatch(software, state.query),
      }),
      [app.rows, browserExtension.rows, agent.rows, builtIn, mcp.rows, plugins, providers, skill.rows, software, state.query],
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
  const failures = [lists.app, lists.browserExtension, lists.mcpServer, lists.skill, lists.agent].flatMap(
    (list) => (list && 'sourceFailures' in list ? list.sourceFailures : []),
  );
  const failedReads = [lists.app, lists.browserExtension, lists.mcpServer, lists.skill, lists.agent]
    .flatMap((list) => list?.error && !list.loading && list.sourceFailures.length === 0
      ? [{ status: list.status, retry: list.refresh }] : []);
  const list: DirectoryList = {
      loading,
      hasNextPage: continuations.length > 0,
      nextPage: async () => {
        await Promise.all(continuations.map((next) => next()));
      },
      // Reads that failed without naming a catalog are one "Couldn't reach the catalogs" line.
      sourceFailures: [...failures, ...(failedReads.length ? [{ sourceId: null, status: failedReads[0]!.status,
        onRetry: async () => { await Promise.all(failedReads.map(failure => failure.retry())); } }] : [])],
  };

  const count = sections.reduce((sum, kind) => sum + byKind[kind].length, 0);
  return { allContributedKinds, contributedKinds, byKind, sections, selectedKind, setKind, totalKnown, preview, rows, groups,
    groupAction, list, loading, count, sourceTitle };
}

/**
 * Discover while its curated catalogs are out (lab h:unreachable, "everything else is here"): every healthy catalog and
 * built-in, each kind previewing its first rows with All N › to its kind page. The same rows and directory as Search.
 */
export function StoreCatalogShelves(props: SearchSectionsInput & Readonly<{ onOpenKind: (kind: string) => void; excludeSourceIds: readonly string[] }>): React.ReactNode {
  const { sections, groups, list, byKind, sourceTitle } = useStoreSearchSections(props);
  // Shelves always preview, even when one kind is all that answered; its All › opens the whole kind.
  const rows = sections.flatMap((kind) => byKind[kind].slice(0, STORE_SECTION_PREVIEW_ROWS).map((row) => ({ ...row, group: kind })));
  const { onOpenKind, excludeSourceIds } = props;
  const groupAction = React.useCallback((groupKey: string): CollectionGroupAction | null => {
    const kind = KIND_ORDER.find((candidate) => candidate === groupKey);
    return kind ? { label: t('capabilities.store.discover.all'), onPress: () => onOpenKind(kind), kind: 'link' } : null;
  }, [onOpenKind]);
  // The curated outage is already said once above; only other named catalogs' failures speak here. A kind read that
  // failed without naming a catalog is that same outage reaching it, so it doesn't get a second line.
  // Shelves preview; each kind's All › pages the rest, so there is no Load more here.
  const shown: DirectoryList = { ...list, hasNextPage: false, sourceFailures: (list.sourceFailures ?? [])
    .filter(failure => failure.sourceId !== null && !excludeSourceIds.includes(failure.sourceId)) };
  if (Object.values(byKind).every(kindRows => kindRows.length === 0) && !list.loading) return null;
  return (
    <Directory kind="search" label={t('capabilities.store.discover.title')} rows={rows} groups={groups} list={shown}
      query="" sourceTitle={sourceTitle} showEmptyState={false} groupAction={groupAction} />
  );
}

function SearchResults(
  props: SearchSectionsInput,
): React.ReactNode {
  const { state } = props;
  const { lists, filter } = state;
  const { allContributedKinds, contributedKinds, selectedKind, setKind, preview, rows, groups,
    groupAction, list, loading, count, sourceTitle } = useStoreSearchSections(props);
  const localize = useProjectedPluginLocalizedTextResolver();
  const phone = !useAppShellColumn().columnVisible;
  const query = state.query.trim();
  // A warm read changes activity, not what the held rows cover or the page's height.
  const partial = filter.result.coverage === 'partial' && count > 0;
  const clearAll = () => {
    state.setQuery('');
    filter.clearFilters();
  };

  return (
    <ItemList pageColumn="wide" testID="store.search">
      <PageContentColumn>
        {/* A phone's navigation bar already names the Store; the page opens on its search (lab hp:search). */}
        {phone ? null : (
          <PageHeader
            actions={<StoreProjectScopeChip />}
            actionsPlacement="page"
            title={t('capabilities.store.discover.title')}
            description={t('capabilities.store.discover.purpose')}
          />
        )}
        <View ref={filter.searchAnchorRef as never}>
          <CompactSearchField
            testID="store.search.field"
            placement="page"
            value={state.query}
            onChangeText={state.setQuery}
            placeholder={t(
              phone
                ? 'capabilities.store.discover.searchShort'
                : 'capabilities.store.discover.search',
            )}
            autoFocus={query.length === 0}
            // The result count, then the funnel that ends the field (lab `spfield` B).
            trailing={
              <>
                {query.length > 0 && !loading && count > 0 ? (
                  <Text
                    variant="meta"
                    style={styles.count}
                    testID="store.search.count"
                  >
                    {t('capabilities.store.search.results', { count })}
                  </Text>
                ) : null}
                {filter.filterButton}
              </>
            }
          />
        </View>
        {/* Kinds narrow what is fetched before it is fetched; a phone reaches the same choice in the filter editor. */}
        {phone ? null : (
          <View style={[styles.inset, styles.kinds]}>
            <SegmentedTabBar<string>
              role="radiogroup"
              // Seven kinds are a list filter, not a 2–4 segment choice: separate pills, each with what it found.
              presentation="pills"
              // A narrow page (a pane beside it) shows the kinds as one field select instead of wrapping them.
              overflow={{ label: t('common.more') }}
              segmentSizing="content"
              accessibilityLabel={t('capabilities.store.search.kind')}
              activeTabId={selectedKind}
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
                ...allContributedKinds.map(kind => ({ id: kind.key,
                  label: localize(kind.pluginId, kind.definition.title), testID: `store.search.kind.${kind.key}` })),
              ]}
              onSelectTab={setKind}
            />
          </View>
        )}
        {filter.tokenRow ? (
          <View style={styles.inset}>{filter.tokenRow}</View>
        ) : null}
        {lists.software ? <SoftwareSource list={lists.software} target={props.softwareTarget} /> : null}
        {/* A pasted Chrome Web Store link or ID is one result: install that extension. */}
        {selectedKind === 'all' || selectedKind === 'browserExtension' ? <StoreBrowserExtensionLinkResult query={query} /> : null}
        <Directory
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
