import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import {
  useIsFocused,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { useDeploymentEnvironmentRowParts } from './DeploymentEnvironmentCollection';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { useDeploymentInventory } from './useDeploymentProject';

export const ALL_DEPLOYMENTS_ROUTE = '/projects/deployments';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
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
    />
  );
});

/** The page over one read; the dev specimen renders it over a fixture transport. */
export const AllDeploymentsView = React.memo(function AllDeploymentsView(
  props: Readonly<{ read: AllDeploymentsRead; serverId: string | null; lifetime?: ServerAccountScopeLifetime | null }>,
) {
  const { read, serverId } = props;
  const { snapshot } = read;
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
  const items = snapshot.value?.items ?? [];

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
            title={t('projects.deployments.allDeniedTitle')}
            reason={t('projects.deployments.allDeniedBody')}
          />
        ) : (
          <SurfaceStateCard
            kind="error"
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
        {header}
        <SurfaceStateCard
          kind="loading"
          title={t('projects.deployments.loading')}
        />
      </ItemList>
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
        />
      </ItemList>
    );
  }
  return (
    <ItemList testID="all-deployments">
      {header}
      {snapshot.status === 'unavailable' ? (
        <SurfaceFreshnessLine
          testID="all-deployments.stale"
          reason={t('projects.deployments.unavailableTitle')}
          action={{ label: t('common.retry'), onPress: retry }}
        />
      ) : null}
      {items.length === 0 ? (
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
        <AllDeploymentsGroups items={items} serverId={serverId} lifetime={props.lifetime ?? null} />
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
  );
});

function AllDeploymentsGroups(
  props: Readonly<{ items: readonly EnvironmentItem[]; serverId: string; lifetime: ServerAccountScopeLifetime | null }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const rows = useDeploymentEnvironmentRowParts(
    props.items,
    'all-deployments.row',
    props.lifetime,
  );
  // Projects keep the page's own order: the first Environment of each Project places its group. The name is the
  // admitted Source name the read carries; Projects whose name is unavailable or withdrawn share one last group,
  // so one placeholder is never repeated down the page.
  const groups = React.useMemo(() => {
    const named = new Map<string, { title: string; rows: typeof rows }>();
    const unnamed: typeof rows = [];
    for (const row of rows) {
      if (!row.projectName) { unnamed.push(row); continue; }
      const group = named.get(row.projectSourceId);
      if (group) group.rows.push(row);
      else named.set(row.projectSourceId, { title: row.projectName, rows: [row] });
    }
    const list = [...named.entries()].map(([key, group]) => ({ key, ...group }));
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
              icon={
                <Icon
                  name="hard-drives"
                  size={18}
                  color={theme.colors.text.secondary}
                />
              }
              onPress={() =>
                router.push(
                  deploymentEnvironmentRoute({
                    serverId: props.serverId,
                    projectSourceId: row.projectSourceId,
                    environmentId: row.environmentId,
                  }),
                )
              }
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
