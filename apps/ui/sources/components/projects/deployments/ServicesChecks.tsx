import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { ManagedInventoryCoverage } from '@/components/store/inventory/ManagedInventoryCoverage';
import type { ManagedInventorySectionsState } from '@/components/store/inventory/ManagedInventorySections';
import { isConfiguredCheckResultsPartial, type ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { partialInventoryCoverageState } from '@/components/store/inventory/inventoryCoverage';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machineServiceByline, machineServiceBylineLead, machineServiceColumnFields, machineServiceStateField, renderMachineServicePort } from '@/components/machines/services/machineServiceColumns';
import { machineServiceDisplayName, machineServiceExpectedStop, machineServiceIcon, machineServiceStateSpeaks } from '@/components/machines/services/machineServicesPresentation';
import { useMachineServicesList } from '@/components/machines/services/useMachineServices';
import type { ManagedWatchedServiceRow } from '@/components/store/inventory/managedOperationalInventory';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { describeMachinePresenceSummary } from '@/utils/sessions/machinePresenceLine';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { serviceCheckMonitorSummary } from './serviceCheckPresentation';
import { ServiceCheckList, type ServiceCheckSelection } from './ServiceCheckList';
import { useServiceCheckOfflineObservers } from './useServiceCheckOfflineObservers';
import { SERVICES_ONE_SHEET, ServicesPageList } from './DeploymentEnvironmentRows';
import { watchedServiceBands, watchedServiceItems, type WatchedMachineRead, type WatchedServiceItem } from './watchedServiceItems';
import { ServicesPaging, useReportViewCount, type ServicesViewCount } from './ServicesViews';

const NO_OPEN = () => {};
const CHECK_KINDS = ['configuredCheck'] as const;
const WATCHED_KINDS = ['watchedService'] as const;

type ServicesFamily = ManagedInventorySectionsState['families'][number];

/**
 * A family's coverage on a Services view, in the inventory's own words (ManagedInventoryCoverage): reading, settled
 * short, or why it could not be read. Never "none" for an unread list, and never silent beside listed rows (REVIEW-2
 * R2). A page that continues in place is offered under the rows instead (servicesFamilyMore); `rowFacts` names partial
 * reads about the listed rows' own facts, which their cells already say.
 */
export function servicesFamilyCoverage(family: ServicesFamily | undefined, listed: boolean, testID: string,
  rowFacts?: (reason: unknown) => boolean): React.ReactNode | null {
  const coverage = family?.result.coverage;
  if (!family || coverage === undefined || coverage === 'available') return null;
  if (coverage === 'loading')
    return listed ? null : (
      <ItemGroup surface="none" testID={`${testID}.loading`}>
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  if (listed && typeof coverage === 'object' && !('unavailable' in coverage)
    && (rowFacts?.(coverage.partial) === true || servicesFamilyMore(family, rowFacts) !== null)) return null;
  return <ManagedInventoryCoverage families={[family]} testIDPrefix={testID} />;
}

/** The family's next page, followed in place on intent (ServicesPaging Show more); none for a read that settled short. */
export function servicesFamilyMore(family: ServicesFamily | undefined, rowFacts?: (reason: unknown) => boolean): (() => unknown) | null {
  const coverage = family?.result.coverage;
  if (!family || typeof coverage !== 'object' || 'unavailable' in coverage || rowFacts?.(coverage.partial) === true) return null;
  if (partialInventoryCoverageState(coverage.partial) !== 'paged') return null;
  return typeof family.result.continuation === 'function' ? family.result.continuation as () => unknown : null;
}

/**
 * Services → Checks (pfc-redesign svcChk): the Account's saved Checks from the managed inventory owner, each with the
 * state and 30-day uptime its health results report. A Check opens beside the page (DetailsPane) or as its page.
 */
export function ServicesChecksView(
  props: Readonly<{
    scope: ServerAccountScope | null;
    presented: boolean;
    selectedKey: string | null;
    onSelect: (row: ManagedConfiguredCheckRow) => void;
    /** The selected Check's current row (its results move on), for the details pane the page hosts. */
    onSelectedRow: (row: ManagedConfiguredCheckRow | null) => void;
    onCount: (count: ServicesViewCount) => void;
  }>,
) {
  const query = React.useMemo(
    () => ({
      scope: props.scope,
      machine: null,
      projectKey: null,
      presented: props.presented,
      kinds: CHECK_KINDS,
    }),
    [props.presented, props.scope],
  );
  const { selectedKey, onSelect, onSelectedRow } = props;
  const selection = React.useMemo<ServiceCheckSelection>(() => ({ selectedKey, onSelect, onSelectedRow }),
    [onSelect, onSelectedRow, selectedKey]);
  return (
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
        const family = state.families.find((candidate) => candidate.kind === 'configuredCheck');
        const pending = servicesFamilyCoverage(family, rows.length > 0, 'services.checks', isConfiguredCheckResultsPartial);
        if (rows.length === 0) {
          return (
            pending ?? (
              <EmptyState
                testID="services.checks.empty"
                layout="page"
                scene="noAutomations"
                title={t('projects.deployments.services.noChecks')}
                subtitle={t('projects.deployments.services.noChecksBody')}
              />
            )
          );
        }
        const more = servicesFamilyMore(family, isConfiguredCheckResultsPartial);
        return (
          <>
            {pending}
            <ChecksList rows={rows} scope={props.scope} selection={selection} onCount={props.onCount} partial={more !== null} />
            <ServicesPaging testID="services.checks.paging" more={more} />
          </>
        );
      }}
    </MachineManagedInventorySection>
  );
}


/** Services → Checks: the shared Checks collection, and the view's count with how many fail. */
function ChecksList(props: Readonly<{
  rows: readonly ManagedConfiguredCheckRow[];
  scope: ServerAccountScope | null;
  selection: ServiceCheckSelection;
  onCount: (count: ServicesViewCount) => void;
  /** More Automation pages may hold more Checks: the count says "at least" until they are read. */
  partial: boolean;
}>) {
  const { rows, partial } = props;
  const offlineObservers = useServiceCheckOfflineObservers(rows, props.scope);
  const summary = React.useMemo(() => serviceCheckMonitorSummary(rows, offlineObservers), [rows, offlineObservers]);
  const { down, degraded } = summary;
  // Monitoring's words and tones (monitoring-1115 A1 "1 down · 1 slow"): one word per state on every Check surface.
  const count = React.useMemo(() => [partial ? t('projects.deployments.monitoring.checksAtLeast', { count: rows.length })
    : t('projects.deployments.services.countChecks', { count: rows.length }),
    down > 0 ? { text: t('projects.deployments.monitoring.glanceDown', { count: down }), tone: 'danger' as const } : null,
    degraded > 0 ? { text: t('projects.deployments.monitoring.glanceFailing', { count: degraded }), tone: 'warning' as const } : null],
  [degraded, down, partial, rows.length]);
  useReportViewCount('checks', count, props.onCount, down);
  return (
    <ServiceCheckList testID="services.checks" rows={rows} scope={props.scope} selection={props.selection}
      accessibilityLabel={t('projects.deployments.services.checks')} />
  );
}

/**
 * Services → Watched (lab svcWatch): the services someone watches on their Machines, banded by Machine, each drawn as
 * the Machine's own Services list draws it (its byline and its Ports, Memory and Up) from that Machine's service read;
 * a row opens the service on its Machine.
 */
export function ServicesWatchedView(
  props: Readonly<{ scope: ServerAccountScope | null; presented: boolean; onCount: (count: ServicesViewCount) => void }>,
) {
  const query = React.useMemo(
    () => ({
      scope: props.scope,
      machine: null,
      projectKey: null,
      presented: props.presented,
      kinds: WATCHED_KINDS,
    }),
    [props.presented, props.scope],
  );
  return (
    <MachineManagedInventorySection
      query={query}
      groupBy="machine"
      openKey={null}
      onOpenChange={NO_OPEN}
    >
      {(state) => {
        const family = state.families.find((candidate) => candidate.kind === 'watchedService');
        return state.rows.length === 0 ? (
          (servicesFamilyCoverage(family, false, 'services.watched') ?? (
            <EmptyState
              testID="services.watched.empty"
              layout="page"
              scene="nothingListening"
              title={t('projects.deployments.services.noWatched')}
              subtitle={t('projects.deployments.services.noWatchedBody')}
            />
          ))
        ) : (
          <>
            {servicesFamilyCoverage(family, true, 'services.watched')}
            <WatchedList state={state} serverId={props.scope?.serverId ?? null} scope={props.scope} presented={props.presented}
              onCount={props.onCount} />
            <ServicesPaging testID="services.watched.paging" more={servicesFamilyMore(family)} />
          </>
        );
      }}
    </MachineManagedInventorySection>
  );
}

type WatchedItem = WatchedServiceItem;
const keyOfWatched = (item: WatchedItem) => item.key;
const groupOfWatched = (item: WatchedItem) => item.machineId;
const NO_SERVICE_READS: ReadonlyMap<string, WatchedMachineRead> = new Map();

function WatchedList(props: Readonly<{
  state: ManagedInventorySectionsState;
  serverId: string | null;
  scope: ServerAccountScope | null;
  presented: boolean;
  onCount: (count: ServicesViewCount) => void;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const watches = React.useMemo(() => props.state.rows.filter((row): row is ManagedWatchedServiceRow =>
    row.kind === 'watchedService'), [props.state.rows]);
  const machineIds = React.useMemo(() => [...new Set(watches.map((row) => row.machineId))], [watches]);
  const names = useMachineDisplayNamesById(machineIds);
  // Each Machine's own service read, once per Machine that has watches, while the view is shown.
  const [reads, setReads] = React.useState(NO_SERVICE_READS);
  const report = React.useCallback((machineId: string, read: WatchedMachineRead) => {
    setReads((current) => {
      const previous = current.get(machineId);
      if (previous && previous.status === read.status && previous.rows === read.rows) return current;
      const next = new Map(current);
      next.set(machineId, read);
      return next;
    });
  }, []);
  const items = React.useMemo(() => watchedServiceItems(watches, reads), [reads, watches]);
  const hrefs = props.state.presentations;
  // A Machine's read state is said once, on its band (with Retry when it failed); its rows keep name and purpose.
  const bands = React.useMemo(() => watchedServiceBands(machineIds, reads, names), [machineIds, names, reads]);
  const groups = React.useMemo(() => ({
    axis: bands.map((band) => ({ key: band.key, title: band.title ?? t('machineServices.groups.watched'),
      section: SERVICES_ONE_SHEET,
      // A Machine this Home cannot reach says so in its presence owner's word, with no Retry (the Machine page's rule).
      ...(band.read === 'failed' ? { description: t('machineServices.error.title'), tone: 'attention' as const }
        : band.presence !== null ? { description: band.presence }
        : band.read === 'reading' ? { description: t('machineServices.loading') } : {}) })),
    groupOf: groupOfWatched,
  }), [bands]);
  const refreshers = React.useRef(new Map<string, () => void>());
  const registerRefresh = React.useCallback((machineId: string, refresh: () => void) => {
    refreshers.current.set(machineId, refresh);
  }, []);
  const groupAction = React.useCallback((machineId: string) => {
    const band = bands.find((candidate) => candidate.key === machineId);
    const refresh = refreshers.current.get(machineId);
    return band?.read === 'failed' && refresh ? { label: t('common.retry'), onPress: refresh, kind: 'link' as const } : null;
  }, [bands]);
  const open = React.useCallback((key: string | number | null) => {
    const item = key === null ? undefined : items.find((candidate) => candidate.key === String(key));
    const href = item ? hrefs.get(item.key)?.home.href : undefined;
    if (href) router.push(href as never);
  }, [hrefs, items, router]);
  const model = useHappierCollection<WatchedItem>({ items, keyOf: keyOfWatched, groups, openKey: null, onOpenChange: open });
  const anatomy = React.useMemo<CollectionAnatomy<WatchedItem>>(() => ({
    glyph: (item) => <Icon name={item.service ? machineServiceIcon(item.service) : 'eye'} size={ICON_SIZE.md}
      color={theme.colors.text.secondary} />,
    title: (item) => item.service ? machineServiceDisplayName(item.service) : item.name,
    // Line 2 is the Machine list's line (what the service is); the State column says its state where columns are
    // drawn. Before its Machine answers, the line says why it watches it and that it is still reading (or couldn't).
    byline: (item, layout) => item.service
      ? machineServiceByline(item.service, layout?.fieldColumns === true)
      : <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 }} numberOfLines={1}>
          {item.lifecyclePurpose === 'infrastructure' ? t('projects.deployments.services.watchedInfrastructureByline')
            : t('projects.deployments.services.watchedServiceByline')}
        </Text>,
    bylineLead: (item, layout) => item.service ? machineServiceBylineLead(item.service, layout?.fieldColumns === true) : null,
    titleMeta: (item) => item.service ? renderMachineServicePort(item.service) : null,
    titleMetaAlign: 'row',
    fields: [...machineServiceColumnFields<WatchedItem>((item) => item.service), machineServiceStateField<WatchedItem>((item) => item.service)],
    accessibilityLabel: (item) => [item.service ? machineServiceDisplayName(item.service) : item.name, names[item.machineId]]
      .filter(Boolean).join(', '),
    testID: (item) => `services.watched.row.${item.key}`,
    columnTitles: { title: t('machineServices.columns.service') },
  }), [names, theme.colors.text.secondary]);
  const count = React.useMemo(() => [t('projects.deployments.services.countWatched',
    { services: items.length, machines: machineIds.length })], [items.length, machineIds.length]);
  // The Watched tab's needs-you count: services whose own state needs the person (the Machine list's rule).
  const watchedNeedYou = items.filter((item) => item.service && machineServiceExpectedStop(item.service) === null
    && machineServiceStateSpeaks(item.service.state)).length;
  useReportViewCount('watched', count, props.onCount, watchedNeedYou);
  return (
    <>
      {props.serverId ? machineIds.map((machineId) => (
        <WatchedMachineReader key={machineId} serverId={props.serverId!} machineId={machineId} active={props.presented}
          onRead={report} onRefresh={registerRefresh} />
      )) : null}
      <ServicesPageList<WatchedItem> testID="services.watched" model={model} anatomy={anatomy}
        accessibilityLabel={t('projects.deployments.services.watched')} groupAction={groupAction} />
    </>
  );
}

/** One Machine's service read (no UI of its own), reported up so the Watched rows draw its facts. */
function WatchedMachineReader(props: Readonly<{ serverId: string; machineId: string; active: boolean;
  onRead: (machineId: string, read: WatchedMachineRead) => void;
  onRefresh: (machineId: string, refresh: () => void) => void }>) {
  const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId, active: props.active });
  const { onRead, onRefresh, machineId } = props;
  const { refresh } = list;
  React.useEffect(() => { onRefresh(machineId, () => { void refresh(); }); }, [machineId, onRefresh, refresh]);
  const failed = Boolean(list.error || list.unavailable);
  const rows = list.rows ?? null;
  // The Machine presence owner's word while this Home cannot reach it, pushed on every heartbeat (the record itself
  // does not move with presence), as the Machines list reads it.
  const summary = useMachinePresenceSummary(props.serverId, machineId);
  const presence = summary.machineIsKnown ? describeMachinePresenceSummary(summary) : null;
  const unreachable = presence?.status === 'offline' && presence.label ? presence.label : null;
  React.useEffect(() => {
    // An unreachable Machine settles on its presence; still reading reports nothing; a read that answered or failed
    // reports its rows (the last listed ones on failure).
    if (unreachable !== null) onRead(machineId, { status: 'unreachable', rows, presence: unreachable });
    else if (rows !== null || failed) onRead(machineId, { status: failed ? 'failed' : 'listed', rows });
  }, [failed, machineId, onRead, rows, unreachable]);
  return null;
}
