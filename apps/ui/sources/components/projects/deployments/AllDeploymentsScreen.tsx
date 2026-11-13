import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import {
  useIsFocused,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
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

import { isSameDeploymentName, useDeploymentEnvironmentRowParts, useDeploymentEnvironmentRowSelection } from './DeploymentEnvironmentCollection';
import { useDeviceType } from '@/utils/platform/responsive';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { useDeploymentInventory } from './useDeploymentProject';
import { useVisibleBackupCoverage } from './useVisibleBackupCoverage';

export const ALL_DEPLOYMENTS_ROUTE = '/projects/deployments';

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
 * Projects → All deployments (owner ruling Q9): every Environment this Account can read, one demanded page at a
 * time, grouped by its Project. A row opens the Environment on its Project's Deployments page.
 */
export const AllDeploymentsScreen = React.memo(function AllDeploymentsScreen() {
  const lifetime = useActiveServerAccountScopeLifetime();
  const demand = useDeploymentPresentationDemand(useIsFocused());
  const read = useDeploymentInventory(lifetime, demand);
  return (
    <AllDeploymentsView
      read={read}
      serverId={lifetime?.scope.serverId ?? null}
      lifetime={lifetime}
      presented={demand.visible}
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
    <ItemGroup surface="none" testID="all-deployments.filters">
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
    </ItemGroup>
  ) : null;
  const openNewApp = useOpenNewApp();
  const openDeployApp = React.useCallback(() => openNewApp(), [openNewApp]);
  const header = (
    <PageHeader
      testID="all-deployments.header"
      title={t('projects.deployments.allTitle')}
      description={t('projects.deployments.allDescription')}
      alwaysShowTitle
    />
  );
  const retry = React.useCallback(() => {
    void read.refresh();
  }, [read]);
  const shownItems = React.useMemo(() => filtering ? items.filter((item) => uncovered.has(item.environment.id)) : items,
    [filtering, items, uncovered]);

  if (!snapshot.value && snapshot.status === 'unavailable') {
    const withdrawn = snapshot.failure
      ? WITHDRAWN.has(snapshot.failure.code)
      : false;
    return (
      <ItemList
        testID={withdrawn ? 'all-deployments.denied' : 'all-deployments.error'}
      >
        {header}
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
      <PageLoadingRows testID="all-deployments.loading" header />
    );
  }
  const paged = read.hasNextPage || read.hasPreviousPage;
  if (items.length === 0 && !paged) {
    return (
      <ItemList testID="all-deployments.empty">
        {header}
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
    <ItemList testID="all-deployments">
      {header}
      {notBackedUpFilter}
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

function AllDeploymentsGroups(
  props: Readonly<{
    items: readonly EnvironmentItem[];
    serverId: string;
    lifetime: ServerAccountScopeLifetime | null;
    /** Rows shown for "Not backed up" open where that Environment's backups are set up. */
    openBackups?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  // A phone row keeps its status to one short line; the Environment it opens names the Machine.
  const phone = useDeviceType() === 'phone';
  const parts = useDeploymentEnvironmentRowParts(
    props.items,
    'all-deployments.row',
    props.lifetime,
    phone ? 'rail' : 'row',
  );
  const serverId = props.serverId;
  const openBackups = props.openBackups === true;
  const selectRow = React.useCallback((row: typeof parts[number]) => {
    router.push(deploymentEnvironmentRoute({ serverId, projectSourceId: row.projectSourceId, environmentId: row.environmentId,
      ...(openBackups ? { tab: 'settings' as const, section: 'backups' as const, setup: 'backups' as const } : {}) }));
  }, [router, serverId, openBackups]);
  const rows = useDeploymentEnvironmentRowSelection(parts, row => row.environmentId, selectRow);
  const icon = React.useMemo(() => <Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />,
    [theme.colors.text.secondary]);
  // Projects keep the page's own order: the first Environment of each Project places its group. The name is the
  // admitted Source name the read carries; Projects whose name is unavailable or withdrawn share one last group,
  // so one placeholder is never repeated down the page. A Project whose only Environment carries its name needs no
  // header to say it again: all such Projects share one untitled sheet that leads the page, because an untitled
  // sheet below a titled group reads as part of that group.
  const groups = React.useMemo(() => {
    const named = new Map<string, { title: string; rows: typeof rows }>();
    const unnamed: typeof rows = [];
    for (const row of rows) {
      if (!row.projectName) { unnamed.push(row); continue; }
      const group = named.get(row.projectSourceId);
      if (group) group.rows.push(row);
      else named.set(row.projectSourceId, { title: row.projectName, rows: [row] });
    }
    const list: { key: string; title: string | undefined; rows: typeof rows }[] = [];
    let untitled: { key: string; title: undefined; rows: typeof rows } | null = null;
    for (const [key, group] of named) {
      if (!(group.rows.length === 1 && isSameDeploymentName(group.rows[0]!.title, group.title))) list.push({ key, ...group });
      else if (untitled) untitled.rows.push(...group.rows);
      else untitled = { key, title: undefined, rows: [...group.rows] };
    }
    if (untitled) list.unshift(untitled);
    return unnamed.length ? [...list, { key: 'unnamed', title: t('projects.deployments.allOtherProject'), rows: unnamed }] : list;
  }, [rows]);
  return (
    <>
      {groups.map((group) => (
        <ItemGroup
          key={group.key}
          testID={`all-deployments.project.${group.key}`}
          title={group.title}
        >
          {group.rows.map((row) => (
            <Item
              key={row.environmentId}
              testID={`all-deployments.row.${row.environmentId}`}
              title={row.title}
              titleQualifier={row.titleQualifier}
              subtitle={row.subtitle}
              subtitleLeading={row.subtitleLeading}
              detail={row.detail}
              icon={icon}
              onPress={row.onPress}
            />
          ))}
        </ItemGroup>
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
  },
}));
