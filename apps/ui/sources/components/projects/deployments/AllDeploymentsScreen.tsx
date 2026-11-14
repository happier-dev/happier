import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import {
  useIsFocused,
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import { MainScreenHeader, type MainScreenSearch } from '@/components/navigation/shell/MainScreenHeader';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePageSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { SelectionListFilterChips } from '@/components/ui/selectionList/SelectionListFilterChips';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { DeploymentEnvironmentRows } from './DeploymentEnvironmentRows';
import { useDeviceType } from '@/utils/platform/responsive';
import { useDeploymentInventory } from './useDeploymentProject';
import { readServicesView, ServicesDatabasesView, ServicesDomainsView, ServicesViewTabs, type ServicesView, type ServicesViewCount } from './ServicesViews';
import { deploymentRailState } from './deploymentPresentation';
import { buildServiceCheckHref } from './deploymentNavigation';
import { ServiceCheckDetail } from './ServiceCheckDetail';
import { ServicesChecksView, ServicesWatchedView } from './ServicesChecks';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { DetailsPaneOpenAsPageButton } from '@happier-dev/plugin-ui/components';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { useVisibleBackupCoverage } from './useVisibleBackupCoverage';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
const NO_ITEMS: readonly EnvironmentItem[] = Object.freeze([]);
/** One demanded page of the Account-wide Environment list, as `useDeploymentInventory` returns it. */
export type AllDeploymentsRead = Pick<
  ReturnType<typeof useDeploymentInventory>,
  | 'snapshot'
  | 'refresh'
  | 'hasNextPage'
  | 'hasPreviousPage'
  | 'nextPage'
  | 'previousPage'
>;

/** A refusal that Retry cannot change: the Account's access to these Environments was withdrawn or denied. */
const WITHDRAWN = new Set([
  'access_denied',
  'deployment_access_denied',
  'source_access_denied',
  'authority_changed',
]);

/**
 * Services (pfc-redesign; formerly Projects → All deployments, owner ruling Q9): everything this Account runs, as
 * views of one collection. Apps lists every Environment, one demanded page at a time, grouped by its Project; a row
 * opens the Environment on its Project's Deployments page. The view is the route's own (`view`).
 */
export const AllDeploymentsScreen = React.memo(function AllDeploymentsScreen() {
  const lifetime = useActiveServerAccountScopeLifetime();
  const demand = useDeploymentPresentationDemand(useIsFocused());
  const read = useDeploymentInventory(lifetime, demand);
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
  const view = readServicesView(typeof params.view === 'string' ? params.view : null);
  const selectView = React.useCallback((next: ServicesView) => {
    router.setParams({ view: next === 'apps' ? undefined : next });
  }, [router]);
  // A Check opens beside the page where a pane fits (the Store's pattern: one body for pane and page), otherwise as
  // its own page, which is also the pane's Open as page.
  const besidePage = useDetailsPaneAvailable();
  const [checkKey, setCheckKey] = React.useState<string | null>(null);
  const [checkRow, setCheckRow] = React.useState<ManagedConfiguredCheckRow | null>(null);
  const openCheckPage = React.useCallback((row: ManagedConfiguredCheckRow) => {
    router.push(buildServiceCheckHref({ automationId: row.automationId, triggerId: row.triggerId }) as never);
  }, [router]);
  const selectCheck = React.useCallback((row: ManagedConfiguredCheckRow) => {
    if (besidePage) setCheckKey(row.key);
    else openCheckPage(row);
  }, [besidePage, openCheckPage]);
  const closeCheck = React.useCallback(() => setCheckKey(null), []);
  const checks = React.useMemo(() => ({ selectedKey: checkKey, onSelect: selectCheck, onSelectedRow: setCheckRow }),
    [checkKey, selectCheck]);
  const shown = view === 'checks' && checkKey !== null && checkRow !== null && besidePage ? checkRow : null;
  const details = React.useMemo(() => shown ? {
    header: {
      title: shown.native.name,
      actions: (
        <CorePluginUiPresentationScope>
          <DetailsPaneOpenAsPageButton testID="services.checks.detailPane.openAsPage"
            accessibilityLabel={t('capabilities.store.openAsPage')} onPress={() => openCheckPage(shown)} />
        </CorePluginUiPresentationScope>
      ),
    },
    content: <ItemList testID="services.checks.detail"><ServiceCheckDetail row={shown} /></ItemList>,
  } : null, [openCheckPage, shown]);
  const title = t('projects.deployments.services.title');
  const mainColumn = React.useMemo(() => ({
    hideLabel: t('panes.mainColumn.hidePage', { title }),
    showLabel: t('panes.mainColumn.showPage', { title }),
    identity: { name: title },
  }), [title]);
  return (
    <DetailsPaneHost
      testID="services.detailPane"
      mainColumn={mainColumn}
      onCloseDetails={closeCheck}
      details={details}
      main={(
        <AllDeploymentsView
          read={read}
          serverId={lifetime?.scope.serverId ?? null}
          lifetime={lifetime}
          presented={demand.visible}
          controller={read.controller}
          demand={demand}
          view={view}
          onSelectView={selectView}
          checks={checks}
        />
      )}
    />
  );
});

/** The page over one read; the dev specimen renders it over a fixture transport. */
export const AllDeploymentsView = React.memo(function AllDeploymentsView(
  props: Readonly<{
    read: AllDeploymentsRead;
    serverId: string | null;
    lifetime?: ServerAccountScopeLifetime | null;
    /** Whether the page is on screen: backup coverage is read for the shown Environments only then. */
    presented?: boolean;
    /** The Account-wide read owner the other views (Databases, Domains) demand from; without it only Apps shows. */
    controller?: DeploymentReadControllerV1 | null;
    /** The page's presentation demand: a view reads only while the page is on screen. */
    demand?: DeploymentReadDemandV1;
    view?: ServicesView;
    onSelectView?: (view: ServicesView) => void;
    /** The Checks view's selection, hosted by the page's details pane. */
    checks?: Readonly<{ selectedKey: string | null; onSelect: (row: ManagedConfiguredCheckRow) => void;
      onSelectedRow: (row: ManagedConfiguredCheckRow | null) => void }>;
  }>,
) {
  const { read, serverId } = props;
  const { snapshot } = read;
  const pageStateSize = usePageSurfaceStateSize();
  const items = snapshot.value?.items ?? NO_ITEMS;
  const environments = React.useMemo(() => items.map((item) => item.environment), [items]);
  const backups = useVisibleBackupCoverage(props.lifetime ?? null, environments, props.presented === true);
  const [notBackedUpOnly, setNotBackedUpOnly] = React.useState(false);
  const toggleNotBackedUp = React.useCallback(() => setNotBackedUpOnly((on) => !on), []);
  const uncovered = React.useMemo(() => new Set(backups.coverage?.rows
    .filter((row) => row.status === 'uncovered').map((row) => row.environment.id)), [backups.coverage]);
  // The filter is offered only when it has something to show, and stays while it is on so it can be turned off.
  const filtering = notBackedUpOnly && backups.coverage !== null;
  // Inline under the header, one press away: a header action would fold into the phone's ⋯ (DEPLOY-REACCEPT-1113 D3).
  const notBackedUpFilter = filtering || uncovered.size > 0 ? (
    <View testID="all-deployments.filters">
      <SelectionListFilterChips placement="inline" filters={[{
      id: 'all-deployments.notBackedUp',
      testID: 'all-deployments.notBackedUp',
      label: t('projects.deployments.notBackedUp'),
      valueLabel: uncovered.size > 0
        ? t('projects.deployments.notBackedUpCount', { count: uncovered.size })
        : t('projects.deployments.notBackedUp'),
      selected: filtering,
      onToggle: toggleNotBackedUp,
    }]} />
    </View>
  ) : null;
  const openNewApp = useOpenNewApp();
  const openDeployApp = React.useCallback(() => openNewApp(), [openNewApp]);
  // One create on Services (reuse map §4): Deploy an app, the flow every entry opens. The empty page's scene carries it
  // instead, so the page never shows two.
  const deployCreate = React.useMemo<PageCreateAction>(() => ({ label: t('newApp.title'), onPress: openDeployApp,
    testID: 'all-deployments.deployApp' }), [openDeployApp]);
  const view = props.controller && props.demand ? props.view ?? 'apps' : 'apps';
  const viewDemand = props.demand!;
  const phone = useDeviceType() === 'phone';
  const viewTabs = props.controller && props.demand ? (
    <ServicesViewTabs active={view} onSelect={(next) => props.onSelectView?.(next)} />
  ) : null;
  // The main-screen head (lab svcHead): the title row's magnifier and create, the views and their filter right under
  // it, then the count line from the shown view's own reported counts.
  const [query, setQuery] = React.useState('');
  const search = React.useMemo<MainScreenSearch>(() => ({ value: query, onChangeText: setQuery,
    placeholder: t('projects.deployments.services.searchPlaceholder'), testID: 'all-deployments.search' }), [query]);
  const [viewCount, setViewCount] = React.useState<ServicesViewCount | null>(null);
  const appsCount = React.useMemo(() => view === 'apps' ? describeAppsCount(items) : null, [items, view]);
  const count = view === 'apps' ? appsCount : viewCount?.view === view ? viewCount.parts : null;
  const header = (create: boolean) => (
    <MainScreenHeader
      testID="all-deployments.header"
      title={t('projects.deployments.services.title')}
      {...(phone ? {} : { description: t('projects.deployments.services.description') })}
      alwaysShowTitle
      // Wide, the Services column carries the search (one per page); a phone's head keeps its magnifier.
      search={create && phone ? search : null}
      create={create ? deployCreate : null}
      {...(create && !phone ? { createTrigger: <DeployAppButton onPress={openDeployApp} /> } : {})}
      band={viewTabs || (view === 'apps' && notBackedUpFilter) ? <>{viewTabs}{view === 'apps' ? notBackedUpFilter : null}</> : undefined}
      {...(create && count ? { count } : {})}
    />
  );
  const retry = React.useCallback(() => {
    void read.refresh();
  }, [read]);
  // The search narrows the rows already read by the names they show (Environment and Project).
  const needle = query.trim().toLocaleLowerCase();
  const shownItems = React.useMemo(() => items.filter((item) => (!filtering || uncovered.has(item.environment.id))
    && (needle === '' || item.title.toLocaleLowerCase().includes(needle)
      || (item.projectSourceName ?? '').toLocaleLowerCase().includes(needle))),
  [filtering, items, needle, uncovered]);

  // Each view owns its read state; an empty or unavailable Apps page cannot withhold another view.
  const selectedView = view === 'databases' && props.controller && serverId ? (
    <ServicesDatabasesView controller={props.controller} demand={viewDemand} serverId={serverId}
      lifetime={props.lifetime ?? null} onCount={setViewCount} />
  ) : view === 'domains' && props.controller && serverId ? (
    <ServicesDomainsView controller={props.controller} demand={viewDemand} serverId={serverId}
      accountId={props.lifetime?.scope.accountId ?? ''} phone={phone} />
  ) : view === 'checks' && props.checks ? (
    <ServicesChecksView scope={props.lifetime?.scope ?? null} presented={viewDemand.visible}
      selectedKey={props.checks.selectedKey} onSelect={props.checks.onSelect} onSelectedRow={props.checks.onSelectedRow}
      onCount={setViewCount} />
  ) : view === 'watched' ? (
    <ServicesWatchedView scope={props.lifetime?.scope ?? null} presented={viewDemand.visible} onCount={setViewCount} />
  ) : null;
  if (selectedView) {
    return <ItemList testID="all-deployments" pageColumn="wide">{header(true)}{selectedView}</ItemList>;
  }

  if (!snapshot.value && snapshot.status === 'unavailable') {
    const withdrawn = snapshot.failure
      ? WITHDRAWN.has(snapshot.failure.code)
      : false;
    return (
      <ItemList
        pageColumn="wide"
        testID={withdrawn ? 'all-deployments.denied' : 'all-deployments.error'}
      >
        {header(false)}
        {withdrawn ? (
          <SurfaceStateCard
            kind="denied"
            size={pageStateSize}
            title={t('projects.deployments.allDeniedTitle')}
            reason={t('projects.deployments.allDeniedBody')}
          />
        ) : (
          <SurfaceStateCard
            kind="error"
            size={pageStateSize}
            title={t('projects.deployments.allLoadErrorTitle')}
            reason={t('projects.deployments.loadErrorBody')}
            diagnosticCode={snapshot.failure?.code ?? null}
            action={{ label: t('common.retry'), onPress: retry, testID: 'all-deployments.retry' }}
          />
        )}
      </ItemList>
    );
  }
  if (!snapshot.value || !serverId) {
    return (
      <ItemList testID="all-deployments.loading">
        {header(false)}
        <PageLoadingRows />
      </ItemList>
    );
  }
  const paged = read.hasNextPage || read.hasPreviousPage;
  if (items.length === 0 && !paged) {
    return (
      <ItemList testID="all-deployments.empty" pageColumn="wide">
        {header(false)}
        <EmptyState
          layout="page"
          scene="shipped"
          title={t('projects.deployments.allEmptyTitle')}
          subtitle={t('projects.deployments.allEmptyBody')}
          // The page's one way in: Deploy an app, the flow every entry opens (lab svcEmpty, reuse map §1/§4).
          primaryAction={{ label: t('newApp.title'), onPress: openDeployApp, testID: 'all-deployments.empty.deployApp' }}
        />
      </ItemList>
    );
  }
  const unresolved = backups.coverage?.unresolved ?? 0;
  return (
    <>
    {backups.readers}
    <ItemList testID="all-deployments" pageColumn="wide">
      {header(true)}
      {snapshot.status === 'unavailable' ? (
        <SurfaceFreshnessLine
          testID="all-deployments.stale"
          reason={t('projects.deployments.unavailableTitle')}
          action={{ label: t('common.retry'), onPress: retry }}
        />
      ) : null}
      {filtering && unresolved > 0 && backups.coverage?.status !== 'loading' ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="all-deployments.backupsUnresolved"
            kind="unavailable"
            size="line"
            title={t('projects.deployments.backupsUnresolved', { count: unresolved })}
            action={{ label: t('common.retry'), onPress: backups.retry, testID: 'all-deployments.backupsUnresolved.retry' }}
          />
        </ItemGroup>
      ) : null}
      {filtering && shownItems.length === 0 && items.length > 0 ? (
        // Nothing known uncovered: "all backed up" only when every shown Environment answered.
        unresolved > 0 ? null : <ItemGroup surface="none">
          <SurfaceStateCard
            testID="all-deployments.allBackedUp"
            kind="empty"
            size="line"
            title={t('projects.deployments.allBackedUp')}
          />
        </ItemGroup>
      ) : items.length === 0 ? (
        // A page whose rows all belong to Projects this Account can't open still leads on to the next one.
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="all-deployments.pageEmpty"
            kind="empty"
            size="line"
            title={t('projects.deployments.allPageEmpty')}
          />
        </ItemGroup>
      ) : (
        <AllDeploymentsGroups items={shownItems} serverId={serverId} lifetime={props.lifetime ?? null}
          openBackups={filtering} />
      )}
      {paged ? (
        <ItemGroup surface="none" testID="all-deployments.paging">
          <View style={styles.paging}>
            {read.hasPreviousPage ? (
              <SectionActionButton
                testID="all-deployments.newer"
                title={t('projects.deployments.pageNewer')}
                icon="caret-left"
                onPress={read.previousPage}
              />
            ) : null}
            {read.hasNextPage ? (
              <SectionActionButton
                testID="all-deployments.older"
                title={t('projects.deployments.pageOlder')}
                icon="caret-right"
                onPress={read.nextPage}
              />
            ) : null}
          </View>
        </ItemGroup>
      ) : null}
    </ItemList>
    </>
  );
});

/** Environment rows banded by Project: the one Environment row (DeploymentEnvironmentRows), also a Machine's What runs here. */
export function AllDeploymentsGroups(
  props: Readonly<{
    items: readonly EnvironmentItem[];
    serverId: string;
    lifetime: ServerAccountScopeLifetime | null;
    /** Rows shown for "Not backed up" open where that Environment's backups are set up. */
    openBackups?: boolean;
    /** On a Machine's own page: rows leave out the Machine they all run on (lab hereMachine). */
    hereMachine?: boolean;
  }>,
) {
  return (
    <DeploymentEnvironmentRows
      items={props.items}
      serverId={props.serverId}
      lifetime={props.lifetime}
      testID="all-deployments"
      accessibilityLabel={t('projects.deployments.services.apps')}
      {...(props.openBackups ? { openBackups: true } : {})}
      {...(props.hereMachine ? { hereMachine: true } : {})}
    />
  );
}

/** The Apps count line from the read's own rows and their readiness owner's states (lab svcApps status line). */
function describeAppsCount(items: readonly EnvironmentItem[]): readonly (string | null)[] {
  let needYou = 0;
  let deploying = 0;
  for (const item of items) {
    const state = item.currentDeployment ? deploymentRailState(item.currentDeployment.state) : null;
    if (state?.tone) needYou += 1;
    else if (state) deploying += 1;
  }
  const projects = new Set(items.map((item) => item.environment.projectSourceId)).size;
  return [
    items.length > 0 ? t('projects.deployments.services.countEnvironments', { environments: items.length, projects }) : null,
    needYou > 0 ? t('projects.deployments.services.needYou', { count: needYou }) : null,
    deploying > 0 ? t('projects.deployments.services.countDeploying', { count: deploying }) : null,
  ];
}

/** The wide head's labelled create (lab "+ Deploy an app"); a phone keeps the title row's "+". */
function DeployAppButton(props: Readonly<{ onPress: () => void }>) {
  const { theme } = useUnistyles();
  return (
    <RoundButton testID="all-deployments.deployApp:header" size="small" display="secondary" title={t('newApp.title')}
      leading={<Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.primary} />} onPress={props.onPress} />
  );
}

const styles = StyleSheet.create((theme) => ({
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
  },
}));
