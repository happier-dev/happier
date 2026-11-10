import * as React from 'react';
import { RegistrySourcesUnavailable } from '@/components/capabilities/add/RegistrySourcesUnavailable';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { View } from 'react-native';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Stack, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useIsAppDestinationRootPath } from '@/components/appShell/destinations/useCompactAppDestinations';
import { CollectionSearchToggle } from '@/components/ui/lists/collection/CollectionList';
import { PhonePageBackLine } from '@/components/ui/layout/usePageBackControl';
import {
  RegistryShelf,
  resolveRegistryShelfUnavailable,
  type RegistryShelfProjection,
} from '@/components/capabilities/add/RegistryShelf';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreOpenReference } from '../catalog/useStoreOpenReference';
import { StoreDiscoverRegistryIdentityScope } from '../catalog/StoreDiscoverRegistryIdentityScope';
import { StoreListingPaneHost, useOpenStoreListing } from '../StoreListing';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  ItemGroupColumn,
  ItemGroupColumns,
} from '@/components/ui/lists/ItemGroupColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { StoreDiscover } from '../StoreDiscover';
import { StoreSearch } from '../StoreSearch';
import { StoreCatalogShelves } from '../StoreSearchPage';
import { useStoreFilterFields } from '../catalog/useStoreFilterFields';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { StoreProjectScopeChip } from '../StoreProjectScopeChip';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { useStoreUpdatesCount } from '../updates/storeUpdatesSummary';
import { STORE_KIND_ORDER, type StoreKind } from '../catalog/storeKinds';
import { BOT_STORE_KIND } from '../catalog/storeKindContributions';
import { STORE_KIND_GLYPHS, StoreItemMark, storeItemHasArtwork, storeMarkFactsOfReference } from '../catalog/StoreItemMark';
import { useContributedStoreKinds } from '../StoreKindSurface';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { storeEditorialGroupKey } from '../catalog/storeEditorialIdentity';
import {
  StoreDirectory,
  StoreDiscoverItemMark,
  storeKindWord,
} from './StoreDirectorySection';
import {
  findStoreDiscoverCategory,
  findStoreDiscoverJob,
  listStoreDiscoverJobs,
  projectStoreDiscover,
  type StoreDiscoverItem,
  type StoreDiscoverJob,
  type StoreDiscoverPage as StoreDiscoverProjection,
} from './storeDiscoverModel';

type NavigationHref = Parameters<ReturnType<typeof useRouter>['push']>[0];
const PRESENTED = { presented: true } as const;
const NO_IDENTITY_ITEMS: readonly StoreDiscoverItem[] = [];

/** The authored job glyph ids, read into the product's one icon family; an unknown id keeps a neutral glyph. */
const JOB_GLYPHS: Readonly<Record<string, IconName>> = {
  stGauge: 'speedometer',
  fcGlobe: 'globe',
  stAgent: 'robot',
  stDb: 'hard-drives',
  fcAlert: 'bug',
  fcPlayO: 'play-circle',
};
const KINDS = [...STORE_KIND_ORDER, BOT_STORE_KIND.key];
type ComposedKind = typeof KINDS[number];

function useStoreNavigation() {
  const router = useRouter();
  const { project } = useStoreProjectScope();
  const machine = useStoreMachineScope();
  const directory = useStoreDirectoryState().state;
  const openReference = useStoreOpenReference();
  const openListing = useOpenStoreListing();
  const navigateWithFocusReturn = useNavigationFocusReturn();
  const go = React.useCallback(
    (href: string) => {
      const result = runGuardedNavigation(() =>
        navigateWithFocusReturn(() => router.pushRetainingCurrent(href as NavigationHref)),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'StoreDiscoverPages.go' });
    },
    [router, navigateWithFocusReturn],
  );
  return React.useMemo(
    () => ({
      // A choice opens its exact listing like a kind page's row: the pane beside the page, or its own page on a phone.
      // A built-in Agent or a Provider has no registry listing; its home is its own page (`useStoreOpenReference`).
      openItem: (item: StoreDiscoverItem) =>
        item.reference.type === 'registryItem'
          ? openListing(item.reference)
          : openReference(item.reference),
      // The + is its own target: the kind's Add owner at this exact reference.
      addItem: (item: StoreDiscoverItem) => openReference(item.reference),
      openJob: (jobId: string, catalogSourceId: string) =>
        go(buildPluginsHomeRoute('app', { view: 'job', job: jobId, catalogSourceId, project, machine,
          query: directory?.query, filters: directory?.filters })),
      openJobs: () => go(buildPluginsHomeRoute('app', { view: 'jobs', project, machine })),
      openCategory: (categoryId: string, catalogSourceId: string) =>
        go(
          buildPluginsHomeRoute('app', {
            view: 'category',
            category: categoryId,
            catalogSourceId,
            query: directory?.query,
            filters: directory?.filters,
            project, machine,
          }),
        ),
      openKind: (kind: string) =>
        go(kind === 'bot' ? '/plugins/bots' : buildPluginsHomeRoute('app', { view: 'kind', kind, project, machine })),
      openInstalled: () => go(buildPluginsHomeRoute('app', { view: 'installed', project, machine })),
      openUpdates: () => go(buildPluginsHomeRoute('app', { view: 'updates', project, machine })),
      openDiscover: () =>
        go(buildPluginsHomeRoute('app', { view: 'discover', project, machine })),
      search: (query: string) =>
        go(buildPluginsHomeRoute('app', { view: 'search', query, project, machine })),
    }),
    [go, openListing, openReference, project, machine, directory],
  );
}

function kindPlural(kind: ComposedKind): string {
  switch (kind) {
    case 'bot': return t('bots.title');
    case 'app': return t('capabilities.store.kinds.app.title');
    case 'browserExtension': return t('capabilities.store.kinds.browserExtension.title');
    case 'mcpServer':
      return t('capabilities.store.kinds.mcpServer.title');
    case 'skill':
      return t('capabilities.store.kinds.skill.title');
    case 'agent':
      return t('capabilities.store.kinds.agent.title');
    case 'provider':
      return t('capabilities.store.kinds.provider.title');
    case 'plugin':
      return t('capabilities.store.kinds.plugin.title');
    case 'software':
      return t('capabilities.store.kinds.software.title');
  }
}
function kindPurpose(kind: ComposedKind): string {
  switch (kind) {
    case 'bot': return t('botTemplates.storeDescription');
    case 'app': return t('capabilities.store.kinds.app.description');
    case 'browserExtension': return t('capabilities.store.kinds.browserExtension.description');
    case 'mcpServer':
      return t('capabilities.store.kinds.mcpServer.description');
    case 'skill':
      return t('capabilities.store.kinds.skill.description');
    case 'agent':
      return t('capabilities.store.kinds.agent.description');
    case 'provider':
      return t('capabilities.store.kinds.provider.description');
    case 'plugin':
      return t('capabilities.store.kinds.plugin.description');
    case 'software':
      return t('capabilities.store.softwarePage.description');
  }
}

/** "2 ways · MCP server, Skill": only admitted choices are counted. */
function jobFacts(job: StoreDiscoverJob): string {
  return `${t('capabilities.store.discover.jobWays', { count: job.ways })} · ${job.kinds.map(storeKindWord).join(', ')}`;
}

const JOB_MARKS = 4;
const jobKey = (job: StoreDiscoverJob) => storeEditorialGroupKey(job.sourceId, job.id);
const jobProjection: RegistryShelfProjection<StoreDiscoverJob> = {
  keyOf: jobKey,
  title: (job) => job.title,
  description: (job) => job.description,
  testID: jobKey,
};
const itemProjection: RegistryShelfProjection<StoreDiscoverItem> = {
  keyOf: (item) => item.key,
  title: (item) => item.title,
  description: (item) => item.description,
  testID: (item) => item.id,
};
const noAction = () => null;

function JobMarks(props: Readonly<{ job: StoreDiscoverJob }>) {
  // Only real marks: an item without artwork of its own adds nothing to the strip (a row of kind glyphs or
  // initials beside the job's own glyph reads as noise), and a job with none draws no strip.
  const marks = props.job.groups
    .flatMap((group) => group.items)
    .map((item) => ({ key: item.key, facts: storeMarkFactsOfReference(item.kind, item.title, item.reference) }))
    .filter((entry) => storeItemHasArtwork(entry.facts))
    .slice(0, JOB_MARKS);
  if (marks.length === 0) return null;
  return (
    <View
      style={styles.marks}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {marks.map((entry) => (
        <StoreItemMark key={entry.key} facts={entry.facts} size={16} />
      ))}
    </View>
  );
}

function JobGlyph(props: Readonly<{ job: StoreDiscoverJob }>) {
  const { theme } = useUnistyles();
  return (
    <Icon
      name={JOB_GLYPHS[props.job.glyph] ?? 'squares-four'}
      size={20}
      color={theme.colors.text.secondary}
    />
  );
}

/** Job cards: what you want done, the marks of what does it, and how many real ways there are. */
function StoreJobShelf(
  props: Readonly<{
    testID: string;
    title: string;
    description?: string;
    jobs: readonly StoreDiscoverJob[];
    all?: boolean;
    onOpen: (job: StoreDiscoverJob) => void;
    browseAll?: Readonly<{ label: string; onPress: () => void }>;
  }>,
) {
  return (
    <RegistryShelf<StoreDiscoverJob>
      testID={props.testID}
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
      items={props.jobs}
      projection={jobProjection}
      loading={false}
      where={jobFacts}
      glyph={(job) => <JobGlyph job={job} />}
      headerRight={(job) => <JobMarks job={job} />}
      action={noAction}
      onOpen={props.onOpen}
      columnTitle={props.title}
      {...(props.all ? { showAll: true } : {})}
      {...(props.browseAll ? { browseAll: props.browseAll } : {})}
    />
  );
}

function DiscoverHeader(
  props: Readonly<{ title: string; description: string; testID: string }>,
) {
  return (
    <PageHeader
      testID={props.testID}
      title={props.title}
      alwaysShowTitle
      description={props.description}
      actions={<StoreProjectScopeChip />}
      actionsPlacement="page"
    />
  );
}

/** A Discover page's frame: the page in its column with the listing pane beside it (the kind pages' host). */
function DiscoverFrame(
  props: Readonly<{ title: string; testID: string; children: React.ReactNode;
    identityItems?: readonly StoreDiscoverItem[]; presented?: boolean }>,
) {
  return (
    <StoreDiscoverRegistryIdentityScope items={props.identityItems ?? NO_IDENTITY_ITEMS} presented={props.presented ?? false}>
      <StoreListingPaneHost title={props.title} testID={props.testID}>
        <ItemList pageColumn="wide" testID={props.testID}>
          <PageContentColumn>{props.children}</PageContentColumn>
        </ItemList>
      </StoreListingPaneHost>
    </StoreDiscoverRegistryIdentityScope>
  );
}

function PhoneInstalledRow(props: Readonly<{ onOpen: () => void; onOpenUpdates: () => void; onOpenKind: (kind: string) => void }>) {
  const { theme } = useUnistyles();
  const contributedKinds = useContributedStoreKinds();
  const localize = useProjectedPluginLocalizedTextResolver();
  const [kindsOpen, setKindsOpen] = React.useState(false);
  // Last complete check only; unknown (null) and nothing waiting (0) both draw no badge.
  const waiting = useStoreUpdatesCount(useAccountSettingsScope());
  return (
    <ItemGroup testID="store.discover.pinned">
      <Item
        testID="store.discover.pinned.installed"
        title={t('settingsPlugins.surfaces.installed')}
        icon={<Icon name="check" size={20} color={theme.colors.text.secondary} />}
        onPress={props.onOpen}
      />
      <Item
        testID="store.discover.pinned.updates"
        title={t('capabilities.store.updates.title')}
        icon={<Icon name="arrow-up" size={20} color={theme.colors.text.secondary} />}
        detail={waiting ? String(waiting) : undefined}
        onPress={props.onOpenUpdates}
      />
      {/* A phone has no Store column: every kind is one tap under the search, not nine sections down. */}
      <ExpandableItem
        testID="store.discover.pinned.kinds"
        expanded={kindsOpen}
        onExpandedChange={setKindsOpen}
        header={({ headerProps }) => (
          <Item
            {...headerProps}
            testID="store.discover.pinned.kinds.row"
            title={t('capabilities.store.discover.kindsTitle')}
            icon={<Icon name="squares-four" size={20} color={theme.colors.text.secondary} />}
          />
        )}
      >
        {KINDS.map((kind) => (
          <Item
            key={kind}
            testID={`store.discover.kinds.${kind}`}
            title={kindPlural(kind)}
            icon={<Icon name={STORE_KIND_GLYPHS[kind]} size={20} color={theme.colors.text.secondary} />}
            onPress={() => props.onOpenKind(kind)}
          />
        ))}
        {contributedKinds.map((kind) => (
          <Item
            key={kind.key}
            testID={`store.discover.kinds.${kind.key}`}
            title={localize(kind.pluginId, kind.definition.title)}
            onPress={() => props.onOpenKind(kind.key)}
          />
        ))}
      </ExpandableItem>
    </ItemGroup>
  );
}

function DiscoverSearch(
  props: Readonly<{ onSubmit: (query: string) => void; short?: boolean; autoFocus?: boolean }>,
) {
  const [query, setQuery] = React.useState('');
  return (
    <View style={styles.search}>
      <CompactSearchField
        testID="store.discover.search"
        placement="page"
        value={query}
        onChangeText={setQuery}
        placeholder={t(props.short ? 'capabilities.store.discover.searchShort' : 'capabilities.store.discover.search')}
        {...(props.autoFocus ? { autoFocus: true } : {})}
        onSubmitEditing={() => {
          if (!query.trim()) return;
          props.onSubmit(query.trim());
          // The query moves to the Search page; Discover never filters, so its field must not keep words it ignores.
          setQuery('');
        }}
      />
    </View>
  );
}

/** The curated sources' one quiet outage line with its Retry (the shared owner); the rest of the page stays useful. */
function CurationUnavailable(
  props: Readonly<{ curation: RegistryCuration; testID: string }>,
) {
  const failures = props.curation.sourceFailures;
  const unavailable = (failures.length ? failures : [null]).flatMap(failure => {
    const state = resolveRegistryShelfUnavailable({
      sourceId: failure?.sourceId ?? null,
      error: props.curation.error,
      status: props.curation.status,
      sourceFailures: failure ? [failure] : [],
      refresh: props.curation.refresh,
    }, sourceId => props.curation.sources.find(source => source.id === sourceId)?.title);
    return state ? [{ ...state, sourceId: failure?.sourceId ?? null }] : [];
  });
  // On a phone the line follows the pinned Installed group, so it starts one section gap below it like any block.
  const phone = !useAppShellColumn().columnVisible;
  if (!unavailable.length) return null;
  return (
    <View style={[styles.stateLines, phone ? styles.afterGroup : null]}>
      <RegistrySourcesUnavailable
        testID={props.testID}
        failures={unavailable.map(state => ({ key: state.sourceId ?? 'sources', message: state.message,
          ...(state.details ? { details: state.details } : {}), onRetry: state.onRetry }))}
      />
    </View>
  );
}

/** Every kind the Store browses, as destinations: the page stays useful when no curated shelf is held. */
function BrowseByKind(props: Readonly<{ onOpen: (kind: string) => void }>) {
  const { theme } = useUnistyles();
  const contributedKinds = useContributedStoreKinds();
  const localize = useProjectedPluginLocalizedTextResolver();
  return (
    <ItemGroup
      testID="store.discover.kinds"
      title={t('capabilities.store.discover.kindsTitle')}
      description={t('capabilities.store.discover.kindsDescription')}
      surface="none"
    >
      <ItemGroupColumns columns={2} paddingHorizontal={0} paddingVertical={0}>
        {KINDS.map((kind) => (
          <ItemGroupColumn key={kind}>
            <Item
              rowRole="catalogRow"
              testID={`store.discover.kinds.${kind}`}
              title={kindPlural(kind)}
              subtitle={kindPurpose(kind)}
              subtitleLines={2}
              density="compact"
              icon={
                <Icon
                  name={STORE_KIND_GLYPHS[kind]}
                  size={20}
                  color={theme.colors.text.secondary}
                />
              }
              onPress={() => props.onOpen(kind)}
            />
          </ItemGroupColumn>
        ))}
        {contributedKinds.map(kind => <ItemGroupColumn key={kind.key}>
          <Item rowRole="catalogRow" testID={`store.discover.kinds.${kind.key}`}
            title={localize(kind.pluginId, kind.definition.title)}
            subtitle={kind.definition.description ? localize(kind.pluginId, kind.definition.description) : undefined}
            subtitleLines={2} density="compact" onPress={() => props.onOpen(kind.key)} />
        </ItemGroupColumn>)}
      </ItemGroupColumns>
    </ItemGroup>
  );
}

function DiscoverLoading(props: Readonly<{ testID: string }>) {
  return (
    <SkeletonRows testID={props.testID} rows={5} accessibilityLabel={t('common.loading')} />
  );
}

/**
 * Store → Discover (S40 §9 order): header, search, one featured card, project suggestions, Browse by job, Happier
 * picks, then the category directories. Every slot is the admitted curation's; an absent slot is simply absent.
 */
export const StoreDiscoverPage = React.memo(function StoreDiscoverPage(props: Readonly<{
  project: QualifiedProjectKeyV1 | null;
  /** The Store's own page (`/plugins`), not a Discover pushed from another Store page (`?view=discover`). */
  storeRoot?: boolean;
}>) {
  // The Store is a main screen (a rail destination's own route): the tab bar is its way around, so it has no bar
  // and no Back; its title row stands on the shared head line, where My work's does (owner 11-10). Store pages
  // pushed over it (its `?view=` pages, a Discover opened from Installed) keep their bar and Back.
  const mainScreen = useIsAppDestinationRootPath(usePathname()) && props.storeRoot !== false;
  return <>
    {mainScreen ? <Stack.Screen options={STORE_MAIN_SCREEN_BAR} /> : null}
    <StoreDiscover demand={PRESENTED} project={props.project}>
      {({ curation, suggestions, presented }) => <StoreDiscoverView curation={curation} suggestions={suggestions}
        presented={presented} mainScreen={mainScreen} />}
    </StoreDiscover>
  </>;
});

const STORE_MAIN_SCREEN_BAR = Object.freeze({ headerShown: false });

/** The Store page's presentation over the catalog facts admitted by its read owner. */
export const StoreDiscoverView = React.memo(function StoreDiscoverView(props: Readonly<{
  curation: RegistryCuration;
  suggestions: Parameters<Parameters<typeof StoreDiscover>[0]['children']>[0]['suggestions'];
  /** Live acquisition comes from StoreDiscover; the tour's static preview has no read demand. */
  presented?: boolean;
  /** The Store's own route on a phone draws its main-screen title row (see `StoreDiscoverPage`). */
  mainScreen?: boolean;
}>) {
  const nav = useStoreNavigation();
  const columnVisible = useAppShellColumn().columnVisible;
  // A phone's main-screen title row keeps the search behind its magnifier; a query moves on to the Search page.
  const [searchOpen, setSearchOpen] = React.useState(false);
  const toggleSearch = React.useCallback(() => setSearchOpen(open => !open), []);
  const page = React.useMemo(() => projectStoreDiscover(props.curation.curation, props.suggestions),
    [props.curation.curation, props.suggestions]);
  const identityItems = React.useMemo(() => [
    ...(page.featured ? [page.featured.item] : []), ...page.suggestions,
    ...page.sections.flatMap(section => section.items),
  ], [page]);
  return (
    <DiscoverFrame title={t('capabilities.store.discover.title')} testID="store.discover"
      identityItems={identityItems} presented={props.presented}>
        {columnVisible ? (
          <DiscoverHeader
            testID="store.discover.header"
            title={t('capabilities.store.discover.title')}
            description={t('capabilities.store.discover.purpose')}
          />
        ) : props.mainScreen ? (
          <>
            {/* A phone's Store is a main screen: the shared head line, then its title row with the search behind the magnifier. */}
            <PhonePageBackLine control={null} page />
            <PageHeader
              testID="store.discover.header"
              title={t('settingsPlugins.surfaces.storeTitle')}
              alwaysShowTitle
              actionsPlacement="page"
              actionsLayout="inline"
              actions={<CollectionSearchToggle testID="store.discover.searchToggle" open={searchOpen}
                onPress={toggleSearch} accessibilityLabel={t('capabilities.store.discover.searchShort')} />}
            />
            <View style={styles.inset}><StoreProjectScopeChip /></View>
          </>
        ) : <View style={styles.inset}><StoreProjectScopeChip /></View>}
        {columnVisible || searchOpen || !props.mainScreen
          ? <DiscoverSearch onSubmit={nav.search} short={!columnVisible} autoFocus={searchOpen} />
          : null}
        {/* A phone has no Store column: Installed, Updates and the kinds are pinned under the search. */}
        {columnVisible ? null : <PhoneInstalledRow onOpen={nav.openInstalled} onOpenUpdates={nav.openUpdates} onOpenKind={nav.openKind} />}
        <DiscoverBody curation={props.curation} page={page} nav={nav} presented={props.presented === true} />
    </DiscoverFrame>
  );
});

/** Memoized: Discover's owner re-renders on focus and scope facts; the body redraws for its own curation only. */
const DiscoverBody = React.memo(function DiscoverBody(
  props: Readonly<{
    curation: RegistryCuration;
    page: StoreDiscoverProjection;
    nav: ReturnType<typeof useStoreNavigation>;
    presented: boolean;
  }>,
) {
  const { curation, nav, page } = props;
  const held =
    page.featured !== null || page.suggestions.length > 0 || page.jobs.length > 0 || page.sections.length > 0;
  // No curated shelf to show because its catalogs failed: everything else the Store can read stays on the page.
  const curationOut = !curation.loading && !held && (curation.error !== null || curation.sourceFailures.length > 0);
  const openJob = React.useCallback(
    (job: StoreDiscoverJob) => nav.openJob(job.id, job.sourceId),
    [nav],
  );
  if (curation.loading && !held)
    return <DiscoverLoading testID="store.discover.loading" />;
  return (
    <>
      <CurationUnavailable
        curation={curation}
        testID="store.discover.unavailable"
      />
      {curationOut ? <DiscoverWithoutCuration curation={curation} presented={props.presented} onOpenKind={nav.openKind} /> : null}
      {page.featured ? (
        <RegistryShelf<StoreDiscoverItem>
          testID="store.discover.featured"
          title={t('capabilities.store.discover.featured')}
          description={page.featured.reason}
          items={[page.featured.item]}
          perRow={1}
          projection={itemProjection}
          loading={false}
          where={(item) => storeKindWord(item.kind)}
          glyph={(item) => <StoreDiscoverItemMark item={item} size={HAPPIER_COLLECTION_LIST_METRICS.catalogRow.identityMarkPx} />}
          action={noAction}
          onOpen={nav.openItem}
          columnTitle={t('capabilities.store.discover.featured')}
        />
      ) : null}
      {page.suggestions.length ? (
        <RegistryShelf<StoreDiscoverProjection['suggestions'][number]>
          testID="store.discover.suggestions"
          title={t('capabilities.store.suggestionsTitle')}
          items={page.suggestions}
          projection={itemProjection}
          loading={false}
          where={item => t('capabilities.store.becauseRepository', { repository: item.because.repository.repository })}
          glyph={item => <StoreDiscoverItemMark item={item} size={HAPPIER_COLLECTION_LIST_METRICS.catalogRow.identityMarkPx} />}
          action={noAction}
          onOpen={nav.openItem}
          columnTitle={t('capabilities.store.suggestionsTitle')}
        />
      ) : null}
      {page.jobs.length > 0 ? (
        <StoreJobShelf
          testID="store.discover.jobs"
          title={t('capabilities.store.discover.jobsTitle')}
          jobs={page.jobs}
          onOpen={openJob}
          {...(page.jobs.length > 3
            ? {
                browseAll: {
                  label: t('capabilities.store.discover.allJobs'),
                  onPress: nav.openJobs,
                },
              }
            : {})}
        />
      ) : null}
      <StoreDirectory
        testID="store.discover.directory"
        accessibilityLabel={t('capabilities.store.discover.title')}
        sections={page.sections.map((section) => ({
          key: section.id,
          title: section.title ?? t('capabilities.store.picksTitle'),
          description:
            section.title === null
              ? t('capabilities.store.picksDescription')
              : section.description,
          items: section.items,
          all:
            section.categoryId === null
              ? null
              : {
                  label: t('capabilities.store.discover.all'),
                  onPress: () => nav.openCategory(section.categoryId!, section.sourceId!),
                },
        }))}
        showKind
        onOpen={nav.openItem}
        onAdd={nav.addItem}
      />
      {/* No kinds here: the Store column (or a phone's pinned Browse by kind) already lists every kind. */}
    </>
  );
});

const NO_CURATION: RegistryCuration['curation'] = [];

/** The healthy catalogs and built-ins, kind by kind, read through the same owners Search uses. */
function DiscoverWithoutCuration(props: Readonly<{ curation: RegistryCuration; presented: boolean; onOpenKind: (kind: string) => void }>) {
  const fields = useStoreFilterFields(NO_CURATION, props.presented);
  const demand = React.useMemo(() => ({ presented: props.presented }), [props.presented]);
  const failedSources = React.useMemo(() => props.curation.sourceFailures.map(failure => failure.sourceId),
    [props.curation.sourceFailures]);
  return (
    <StoreSearch demand={demand} fields={fields} curation={NO_CURATION} curationComplete={false}>
      {(state) => <StoreCatalogShelves state={state} presented={props.presented} softwareTarget={null}
        onOpenKind={props.onOpenKind} excludeSourceIds={failedSources} />}
    </StoreSearch>
  );
}

/** Store → Browse by job: every job with at least one admitted choice. */
export const StoreJobsPage = React.memo(function StoreJobsPage() {
  const nav = useStoreNavigation();
  const openJob = React.useCallback(
    (job: StoreDiscoverJob) => nav.openJob(job.id, job.sourceId),
    [nav],
  );
  return (
    <DiscoverFrame title={t('capabilities.store.discover.jobsTitle')} testID="store.jobs">
        <DiscoverHeader
          testID="store.jobs.header"
          title={t('capabilities.store.discover.jobsTitle')}
          description={t('capabilities.store.discover.jobsPurpose')}
        />
        <StoreDiscover demand={PRESENTED} project={null}>
          {({ curation }) => {
            const jobs = listStoreDiscoverJobs(curation.curation);
            if (curation.loading && jobs.length === 0)
              return <DiscoverLoading testID="store.jobs.loading" />;
            return (
              <>
                <CurationUnavailable
                  curation={curation}
                  testID="store.jobs.unavailable"
                />
                {jobs.length > 0 ? (
                  <StoreJobShelf
                    testID="store.jobs.list"
                    title=""
                    jobs={jobs}
                    all
                    onOpen={openJob}
                  />
                ) : (
                  <MissingState
                    testID="store.jobs.empty"
                    title={t('capabilities.store.discover.jobMissingTitle')}
                    reason={t('capabilities.store.discover.jobMissingBody')}
                    onBrowse={nav.openDiscover}
                    curation={curation}
                    onOpenKind={nav.openKind}
                  />
                )}
              </>
            );
          }}
        </StoreDiscover>
    </DiscoverFrame>
  );
});

function MissingState(
  props: Readonly<{
    testID: string;
    title: string;
    reason: string;
    onBrowse: () => void;
    /** The catalog itself could not be read: its outage line already says so, so offer the kinds instead of claiming removal. */
    curation: RegistryCuration;
    onOpenKind: (kind: string) => void;
  }>,
) {
  if (props.curation.error || props.curation.sourceFailures.length > 0) return <BrowseByKind onOpen={props.onOpenKind} />;
  return (
    <View style={styles.inset}>
      <SurfaceStateCard
        testID={props.testID}
        kind="empty"
        size="details"
        title={props.title}
        reason={props.reason}
        action={{
          label: t('capabilities.store.discover.browseAll'),
          onPress: props.onBrowse,
          testID: `${props.testID}.browse`,
        }}
      />
    </View>
  );
}

/** One job: its groups of independent choices, each opening its own listing. Not a checklist or batch install. */
export const StoreJobPage = React.memo(function StoreJobPage(
  props: Readonly<{ jobId: string; catalogSourceId?: string | null }>,
) {
  const nav = useStoreNavigation();
  return (
    <StoreDiscover demand={PRESENTED} project={null}>
      {({ curation, presented }) => {
        const job = findStoreDiscoverJob(curation.curation, props.jobId, props.catalogSourceId);
        if (!job || job.ways === 0) {
          const frame = (children: React.ReactNode) => (
            <DiscoverFrame title={t('capabilities.store.discover.jobsTitle')} testID="store.job">
              {children}
            </DiscoverFrame>
          );
          if (curation.loading)
            return frame(<DiscoverLoading testID="store.job.loading" />);
          return frame(
            <>
              <DiscoverHeader
                testID="store.job.header"
                title={t('capabilities.store.discover.jobsTitle')}
                description=""
              />
              <CurationUnavailable
                curation={curation}
                testID="store.job.unavailable"
              />
              <MissingState
                testID="store.job.missing"
                title={t('capabilities.store.discover.jobMissingTitle')}
                reason={t('capabilities.store.discover.jobMissingBody')}
                onBrowse={nav.openJobs}
                curation={curation}
                onOpenKind={nav.openKind}
              />
            </>,
          );
        }
        return (
          <DiscoverFrame title={job.title} testID="store.job"
            identityItems={job.groups.flatMap(group => group.items)} presented={presented}>
            <DiscoverHeader
              testID="store.job.header"
              title={job.title}
              description={job.description}
            />
            <CurationUnavailable
              curation={curation}
              testID="store.job.unavailable"
            />
            <StoreDirectory
              testID="store.job.groups"
              accessibilityLabel={job.title}
              sections={job.groups.flatMap((group, index) =>
                group.items.length === 0
                  ? []
                  : [{ key: `group:${index}`, title: group.title, description: group.description, items: group.items }],
              )}
              showKind={new Set(job.groups.flatMap((group) => group.items.map((item) => item.kind))).size > 1}
              onOpen={nav.openItem}
              onAdd={nav.addItem}
            />
          </DiscoverFrame>
        );
      }}
    </StoreDiscover>
  );
});

/** One category: every admitted member, as quiet catalog rows. */
export const StoreCategoryPage = React.memo(function StoreCategoryPage(
  props: Readonly<{ categoryId: string; catalogSourceId?: string | null }>,
) {
  const nav = useStoreNavigation();
  return (
    <StoreDiscover demand={PRESENTED} project={null}>
      {({ curation, presented }) => {
        const category = findStoreDiscoverCategory(
          curation.curation,
          props.categoryId,
          props.catalogSourceId,
        );
        if (!category || category.items.length === 0) {
          const frame = (children: React.ReactNode) => (
            <DiscoverFrame title={t('capabilities.store.discover.title')} testID="store.category">
              {children}
            </DiscoverFrame>
          );
          if (curation.loading)
            return frame(<DiscoverLoading testID="store.category.loading" />);
          return frame(
            <>
              <DiscoverHeader
                testID="store.category.header"
                title={t('capabilities.store.discover.title')}
                description=""
              />
              <CurationUnavailable
                curation={curation}
                testID="store.category.unavailable"
              />
              <MissingState
                testID="store.category.missing"
                title={t('capabilities.store.discover.categoryMissingTitle')}
                reason={t('capabilities.store.discover.categoryMissingBody')}
                onBrowse={nav.openDiscover}
                curation={curation}
                onOpenKind={nav.openKind}
              />
            </>,
          );
        }
        return (
          <DiscoverFrame title={category.title ?? t('capabilities.store.discover.title')} testID="store.category"
            identityItems={category.items} presented={presented}>
            <DiscoverHeader
              testID="store.category.header"
              title={category.title ?? ''}
              description={category.description ?? ''}
            />
            <CurationUnavailable
              curation={curation}
              testID="store.category.unavailable"
            />
            <StoreDirectory
              testID="store.category.items"
              accessibilityLabel={category.title ?? t('capabilities.store.discover.title')}
              sections={[{ key: 'category', title: null, items: category.items }]}
              showKind={new Set(category.items.map((item) => item.kind)).size > 1}
              onOpen={nav.openItem}
              onAdd={nav.addItem}
            />
          </DiscoverFrame>
        );
      }}
    </StoreDiscover>
  );
});

const styles = StyleSheet.create((theme) => ({
  marks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  search: { marginBottom: theme.space.s8 },
  // A phone's scope chip sits on the page gutter beside nothing, hugging its label (as in a page header).
  // A source's state line sits where every Store page puts it: on the page edge, its Try again right after the words.
  stateLines: { marginBottom: theme.space.s8 },
  afterGroup: { paddingTop: PAGE_LIST_METRICS.sectionGapPx },
  inset: {
    paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
    alignItems: 'flex-start',
    marginBottom: theme.space.s8,
  },
}));
