import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { ManagedInventoryCoverage } from '@/components/store/inventory/ManagedInventoryCoverage';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import { readServiceCheckRouteParams } from './deploymentNavigation';
import { ServiceCheckDetail, useServiceCheckMeta } from './ServiceCheckDetail';
import { serviceCheckListFacts } from './serviceCheckPresentation';

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
      ...(address ? { configuredCheck: address } : {}),
    }),
    [presented, scope, address?.automationId, address?.triggerId],
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
          family?.result.coverage === 'loading';
        const unavailable = family && typeof family.result.coverage === 'object'
          && 'unavailable' in family.result.coverage;
        return (
          <ItemList testID="services.check.page">
            {row ? <ServiceCheckPageBody row={row} /> : (
              <MainScreenHeader
                testID="services.check.page.header"
                title={t('projects.deployments.services.checkPageTitle')}
                alwaysShowTitle
              />
            )}
            {unavailable ? (
              <ManagedInventoryCoverage families={[family]} testIDPrefix="services.check.page" />
            ) : row ? null : reading ? (
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

/**
 * The Check page header (lab A3): named by what it checks, as the row the person pressed is, with what it is (kind,
 * cadence, Machine) as its description, right under the name.
 */
/** A found Check as its page shows it: its header (name and what it is), then the one detail body. */
export function ServiceCheckPageBody(props: Readonly<{ row: ManagedConfiguredCheckRow }>) {
  return (
    <>
      {/* The detail owns the check's actions; it hands them to the header's end (lab A3: Check now and ⋯). */}
      <ServiceCheckDetail row={props.row} metaInHeader
        renderHeader={(actions) => <CheckPageHeader row={props.row} actions={actions} />} />
    </>
  );
}

function CheckPageHeader(props: Readonly<{ row: ManagedConfiguredCheckRow; actions: React.ReactNode }>) {
  const meta = useServiceCheckMeta(props.row);
  const title = props.row.definitionFacts.kind === 'loading'
    ? t('projects.deployments.services.checkPageTitle')
    : serviceCheckListFacts(props.row).title;
  return (
    <MainScreenHeader
      testID="services.check.page.header"
      title={title}
      alwaysShowTitle
      // The check's own mark, as its row in Monitoring draws it.
      leading={<PageHeaderMarkIcon name="pulse" />}
      {...(meta ? { description: meta } : {})}
      actions={props.actions}
    />
  );
}
