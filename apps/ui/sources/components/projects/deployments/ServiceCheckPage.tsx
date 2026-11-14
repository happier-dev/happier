import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import { readServiceCheckRouteParams } from './deploymentNavigation';
import { ServiceCheckDetail } from './ServiceCheckDetail';

const CHECK_KINDS = ['configuredCheck'] as const;
const NO_OPEN = () => {};

/**
 * One saved Check as its own Services page (pfc-redesign rdDet-chk / chkp): the same detail body the details pane
 * shows, under the Check's name, found in the Account's managed inventory (the Checks list's own read).
 */
export function ServiceCheckPage() {
  const params =
    useLocalSearchParams<Record<string, string | string[] | undefined>>();
  const address = readServiceCheckRouteParams(params);
  const lifetime = useActiveServerAccountScopeLifetime();
  const presented = useLayoutPresentationActive();
  const scope = lifetime?.scope ?? null;
  const query = React.useMemo(
    () => ({
      scope,
      machine: null,
      projectKey: null,
      presented,
      kinds: CHECK_KINDS,
    }),
    [presented, scope],
  );
  return (
    <MachineManagedInventorySection
      query={query}
      groupBy="kind"
      openKey={null}
      onOpenChange={NO_OPEN}
    >
      {(state) => {
        const row = address
          ? (state.rows.find(
              (candidate): candidate is ManagedConfiguredCheckRow =>
                candidate.kind === 'configuredCheck' &&
                candidate.automationId === address.automationId &&
                candidate.triggerId === address.triggerId,
            ) ?? null)
          : null;
        const family = state.families.find(
          (candidate) => candidate.kind === 'configuredCheck',
        );
        const reading =
          !row &&
          address !== null &&
          (!family || family.result.coverage === 'loading');
        return (
          <ItemList testID="services.check.page">
            <MainScreenHeader
              testID="services.check.page.header"
              title={
                row?.native.name ??
                t('projects.deployments.services.checkPageTitle')
              }
              alwaysShowTitle
            />
            {row ? (
              <ServiceCheckDetail row={row} />
            ) : reading ? (
              <ItemGroup surface="none" testID="services.check.page.loading">
                <SkeletonRows rows={4} />
              </ItemGroup>
            ) : (
              <EmptyState
                testID="services.check.page.missing"
                layout="page"
                scene="noMatch"
                title={t('projects.deployments.services.checkMissingTitle')}
                subtitle={t('projects.deployments.services.checkMissingBody')}
              />
            )}
          </ItemList>
        );
      }}
    </MachineManagedInventorySection>
  );
}
