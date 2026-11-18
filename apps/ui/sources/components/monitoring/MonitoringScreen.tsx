import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { SERVICES_ROUTE } from '@/components/projects/deployments/deploymentNavigation';
import { ServiceCheckList, useServiceCheckSelection, type ServiceCheckSelection } from '@/components/projects/deployments/ServiceCheckList';
import { useServiceCheckOfflineObservers } from '@/components/projects/deployments/useServiceCheckOfflineObservers';
import {
  servicesFamilyCoverage,
  servicesFamilyMore,
} from '@/components/projects/deployments/ServicesChecks';
import { ServicesPaging } from '@/components/projects/deployments/ServicesViews';
import {
  serviceCheckMonitorSummary,
  type ServiceCheckMonitorSummary,
} from '@/components/projects/deployments/serviceCheckPresentation';
import {
  isConfiguredCheckResultsPartial,
  type ManagedConfiguredCheckRow,
} from '@/components/store/inventory/managedOperationalInventory';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

const m = 'projects.deployments.monitoring' as const;
const CHECK_KINDS = ['configuredCheck'] as const;
const NO_OPEN = () => {};
type MonitoringView = 'list' | 'grid';

/**
 * Monitoring (MONITOR-LAB-1115 B): whether everything the person runs is up. The glance line says what is down,
 * degraded and passing; the checks that need the person stand first, then the rest, each drawn by the one Checks row
 * (bars, response, 30-day uptime, state). It reads the Account's saved Checks through the managed inventory (the
 * Services Checks view's own read) and decides no fact itself. A Check opens beside the page or as its page.
 */
export function MonitoringScreen() {
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
  const [view, setView] = React.useState<MonitoringView>('list');
  const { selection, details, closeCheck } = useServiceCheckSelection(true);
  const title = t(`${m}.title`);
  const mainColumn = React.useMemo(
    () => ({
      hideLabel: t('panes.mainColumn.hidePage', { title }),
      showLabel: t('panes.mainColumn.showPage', { title }),
      identity: { name: title },
    }),
    [title],
  );
  return (
    <DetailsPaneHost
      testID="monitoring.detailPane"
      mainColumn={mainColumn}
      onCloseDetails={closeCheck}
      details={details}
      main={
        <ItemList testID="monitoring" pageColumn="wide">
          <MachineManagedInventorySection
            query={query}
            groupBy="kind"
            openKey={null}
            onOpenChange={NO_OPEN}
          >
            {(state) => {
              const rows = state.rows.filter(
                (row): row is ManagedConfiguredCheckRow =>
                  row.kind === 'configuredCheck',
              );
              const family = state.families.find(
                (candidate) => candidate.kind === 'configuredCheck',
              );
              const pending = servicesFamilyCoverage(
                family,
                rows.length > 0,
                'monitoring.checks',
                isConfiguredCheckResultsPartial,
              );
              return (
                <MonitoringBody
                  rows={rows}
                  scope={scope}
                  view={view}
                  onView={setView}
                  selection={selection}
                  pending={pending}
                  reading={rows.length === 0 && pending !== null}
                  more={servicesFamilyMore(
                    family,
                    isConfiguredCheckResultsPartial,
                  )}
                />
              );
            }}
          </MachineManagedInventorySection>
        </ItemList>
      }
    />
  );
}

const MonitoringBody = React.memo(function MonitoringBody(
  props: Readonly<{
    rows: readonly ManagedConfiguredCheckRow[];
    scope: ServerAccountScope | null;
    view: MonitoringView;
    onView: (view: MonitoringView) => void;
    selection: ServiceCheckSelection;
    pending: React.ReactNode | null;
    reading: boolean;
    more: (() => unknown) | null;
  }>,
) {
  const router = useRouter();
  const offlineObservers = useServiceCheckOfflineObservers(props.rows, props.scope);
  const summary = React.useMemo(
    () => serviceCheckMonitorSummary(props.rows, offlineObservers),
    [props.rows, offlineObservers],
  );
  const empty = props.rows.length === 0 && !props.reading;
  const openServices = React.useCallback(
    () => router.push(SERVICES_ROUTE as never),
    [router],
  );
  return (
    <>
      <MainScreenHeader
        testID="monitoring.header"
        title={t(`${m}.title`)}
        alwaysShowTitle
        description={t(`${m}.description`)}
        band={
          empty ? null : (
            <MonitoringBand
              summary={summary}
              view={props.view}
              onView={props.onView}
            />
          )
        }
      />
      {props.pending}
      {empty ? (
        <EmptyState
          testID="monitoring.empty"
          layout="page"
          iconName="pulse"
          title={t(`${m}.emptyTitle`)}
          subtitle={t(`${m}.emptyBody`)}
          primaryAction={{
            label: t(`${m}.openServices`),
            onPress: openServices,
            testID: 'monitoring.empty.openServices',
          }}
        />
      ) : props.rows.length > 0 ? (
        <>
          <ServiceCheckList
            testID="monitoring.checks"
            rows={props.rows}
            scope={props.scope}
            selection={props.selection}
            accessibilityLabel={t(`${m}.checks`)}
            grouping="attention"
            presentation={props.view}
          />
          <ServicesPaging testID="monitoring.checks.paging" more={props.more} />
        </>
      ) : null}
    </>
  );
});

/** The glance line (lab `.glance`): the worst state leads, larger and in its tone; then the rest, quietly. Then List | Cards. */
function MonitoringBand(
  props: Readonly<{
    summary: ServiceCheckMonitorSummary;
    view: MonitoringView;
    onView: (view: MonitoringView) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { summary } = props;
  const parts = [
    summary.down > 0
      ? {
          key: 'down',
          text: t(`${m}.glanceDown`, { count: summary.down }),
          color: theme.colors.state.danger.textForeground,
        }
      : null,
    summary.degraded > 0
      ? {
          key: 'degraded',
          text: t(`${m}.glanceFailing`, { count: summary.degraded }),
          color: theme.colors.state.warning.textForeground,
        }
      : null,
    summary.passing > 0
      ? {
          key: 'passing',
          text: t(`${m}.glancePassing`, { count: summary.passing }),
          color: theme.colors.text.secondary,
        }
      : null,
    summary.notChecked > 0
      ? {
          key: 'notChecked',
          text: t(`${m}.glanceNotChecked`, { count: summary.notChecked }),
          color: theme.colors.text.secondary,
        }
      : null,
  ].filter((part): part is NonNullable<typeof part> => part !== null);
  const tabs = React.useMemo(
    () => [
      {
        id: 'list' as const,
        label: t(`${m}.viewList`),
        icon: (
          <Icon
            name="list"
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
      },
      {
        id: 'grid' as const,
        label: t(`${m}.viewCards`),
        icon: (
          <Icon
            name="squares-four"
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
      },
    ],
    [theme.colors.text.secondary],
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s16,
      }}
    >
      <View
        testID="monitoring.glance"
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          columnGap: theme.space.s24,
          rowGap: theme.space.s4,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        {parts.map((part, index) => (
          <Text
            key={part.key}
            testID={`monitoring.glance.${part.key}`}
            variant={index === 0 && part.key !== 'passing' ? 'title' : 'label'}
            style={{
              color:
                index === 0 && part.key !== 'passing'
                  ? part.color
                  : part.key === 'passing'
                    ? theme.colors.text.primary
                    : part.color,
              fontVariant: ['tabular-nums'],
            }}
          >
            {part.text}
          </Text>
        ))}
      </View>
      <SegmentedTabBar<MonitoringView>
        role="radiogroup"
        tabs={tabs}
        activeTabId={props.view}
        onSelectTab={props.onView}
        testIDPrefix="monitoring.view"
        accessibilityLabel={t(`${m}.viewLabel`)}
        segmentSizing="content"
      />
    </View>
  );
}
