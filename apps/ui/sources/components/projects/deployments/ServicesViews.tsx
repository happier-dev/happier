import * as React from 'react';
import type {
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { formatHappierDataBytesParts } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { databaseEngineTitle, describeDatabaseSize } from './databasePresentation';
import { DeploymentDomainRow } from './DeploymentDomainRow';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import {
  useDeploymentDataServicePage,
  useDeploymentDomainPage,
} from './useDeploymentReads';

/**
 * The Services page's views (pfc-redesign svcApps · svcDb · svcDom): one collection seen three ways, so a tab bar.
 * Checks and Watched join when their Account-wide reads exist; a view never computes a fact its owner doesn't report.
 */
export type ServicesView = 'apps' | 'databases' | 'domains' | 'checks' | 'watched';
const VIEWS: readonly ServicesView[] = ['apps', 'databases', 'domains', 'checks', 'watched'];

/** The route's `view`, read once: anything else is the Apps view. */
export function readServicesView(
  value: string | null | undefined,
): ServicesView {
  return VIEWS.find((view) => view === value) ?? 'apps';
}

export function ServicesViewTabs(
  props: Readonly<{
    active: ServicesView;
    onSelect: (view: ServicesView) => void;
  }>,
) {
  const overflow = React.useMemo(() => ({ label: t('common.more'), testID: 'services.view.more' }), []);
  const tabs = React.useMemo(
    () => [
      { id: 'apps' as const, label: t('projects.deployments.services.apps') },
      {
        id: 'databases' as const,
        label: t('projects.deployments.services.databases'),
      },
      {
        id: 'domains' as const,
        label: t('projects.deployments.services.domains'),
      },
      { id: 'checks' as const, label: t('projects.deployments.services.checks') },
      { id: 'watched' as const, label: t('projects.deployments.services.watched') },
    ],
    [],
  );
  return (
    <ItemGroup surface="none" testID="services.views">
      <SegmentedTabBar<ServicesView>
        role="tablist"
        segmentSizing="content"
        testIDPrefix="services.view"
        // Views that don't fit (a phone) move into More, measured by the bar itself (Machine page pattern).
        overflow={overflow}
        tabs={tabs}
        activeTabId={props.active}
        onSelectTab={props.onSelect}
      />
    </ItemGroup>
  );
}

const NO_ITEMS: readonly never[] = Object.freeze([]);

function describeDatabaseGrowth(
  growth: DeploymentDatabaseSizeV1['growth'],
): string | null {
  if (growth.status !== 'available' || growth.bytes === 0) return null;
  const parts = formatHappierDataBytesParts(Math.abs(growth.bytes), {
    kind: 'storage',
  });
  return t('projects.deployments.services.growth', {
    amount: `${growth.bytes > 0 ? '+' : '−'}${parts.value} ${parts.unit}`,
  });
}

/** Databases: every Environment's data services with the size DB-SIZE-1113's read reports; a row opens its database page. */
export function ServicesDatabasesView(
  props: Readonly<{
    controller: DeploymentReadControllerV1 | null;
    demand: DeploymentReadDemandV1;
    serverId: string;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const read = useDeploymentDataServicePage(props.controller, props.demand);
  const items = read.snapshot.value?.items ?? NO_ITEMS;
  const icon = React.useMemo(
    () => <Icon name="stack" size={18} color={theme.colors.text.secondary} />,
    [theme.colors.text.secondary],
  );
  if (!read.snapshot.value) {
    return read.snapshot.status === 'unavailable' ? (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.databases.error"
          kind="error"
          size="line"
          title={t('projects.deployments.unavailableTitle')}
          diagnosticCode={read.snapshot.failure?.code ?? null}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void read.refresh();
            },
          }}
        />
      </ItemGroup>
    ) : (
      <ItemGroup surface="none" testID="services.databases.loading">
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  }
  const withData = items.filter(
    (item) => (item.databaseSizes?.length ?? 0) > 0,
  );
  if (withData.length === 0) {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.databases.empty"
          scene="shipped"
          kind="empty"
          size="page"
          title={t('projects.deployments.services.noDatabases')}
          reason={t('projects.deployments.services.noDatabasesBody')}
        />
      </ItemGroup>
    );
  }
  return (
    <>
      {withData.map((item) => (
        <ItemGroup
          key={item.environment.id}
          testID={`services.databases.environment.${item.environment.id}`}
          title={item.title}
        >
          {item.databaseSizes!.map((database) => {
            const declared = item.content.template?.data?.find(
              (data) => data.service === database.service,
            );
            return (
              <Item
                key={database.service}
                testID={`services.databases.row.${item.environment.id}.${database.service}`}
                title={database.service}
                subtitle={
                  [
                    declared ? databaseEngineTitle(declared) : null,
                    describeDatabaseGrowth(database.growth),
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                detail={describeDatabaseSize(database.size)}
                icon={icon}
                onPress={() =>
                  router.push(
                    deploymentEnvironmentRoute({
                      serverId: props.serverId,
                      projectSourceId: item.environment.projectSourceId,
                      environmentId: item.environment.id,
                      database: database.service,
                    }),
                  )
                }
              />
            );
          })}
        </ItemGroup>
      ))}
    </>
  );
}

/** Domains: every address with its own state and checks, the Environment's one Domain row (DeploymentDomainRow). */
export function ServicesDomainsView(
  props: Readonly<{
    controller: DeploymentReadControllerV1 | null;
    demand: DeploymentReadDemandV1;
    serverId: string;
    accountId: string;
    phone: boolean;
  }>,
) {
  const read = useDeploymentDomainPage(props.controller, props.demand);
  const items = read.snapshot.value?.items ?? NO_ITEMS;
  if (!read.snapshot.value) {
    return read.snapshot.status === 'unavailable' ? (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.domains.error"
          kind="error"
          size="line"
          title={t('projects.deployments.unavailableTitle')}
          diagnosticCode={read.snapshot.failure?.code ?? null}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void read.refresh();
            },
          }}
        />
      </ItemGroup>
    ) : (
      <ItemGroup surface="none" testID="services.domains.loading">
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  }
  if (items.length === 0) {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.domains.empty"
          scene="nothingListening"
          kind="empty"
          size="page"
          title={t('projects.deployments.services.noDomains')}
          reason={t('projects.deployments.services.noDomainsBody')}
        />
      </ItemGroup>
    );
  }
  return (
    <ItemGroup testID="services.domains">
      {items.map((item) => (
        <DeploymentDomainRow
          key={item.domain.id}
          item={item}
          accountId={props.accountId}
          serverId={props.serverId}
          demand={props.demand}
          disabled={false}
          phone={props.phone}
        />
      ))}
    </ItemGroup>
  );
}
