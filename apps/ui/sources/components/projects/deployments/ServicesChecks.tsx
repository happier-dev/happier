import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { ManagedInventoryCoverage } from '@/components/store/inventory/ManagedInventoryCoverage';
import { RowMark } from '@/components/store/inventory/ManagedInventoryDirectory';
import type { ManagedInventorySectionsState } from '@/components/store/inventory/ManagedInventorySections';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Status, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MachineServiceByline, machineServiceColumnFields, machineServiceStateField, renderMachineServicePort } from '@/components/machines/services/machineServiceColumns';
import { machineServiceDisplayName, machineServiceExpectedStop, machineServiceIcon, machineServiceStateSpeaks } from '@/components/machines/services/machineServicesPresentation';
import { useMachineServicesList } from '@/components/machines/services/useMachineServices';
import type { ManagedWatchedServiceRow } from '@/components/store/inventory/managedOperationalInventory';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import {
  readServiceCheckFacts,
  serviceCheckListFacts,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
  type ServiceCheckStatus,
} from './serviceCheckPresentation';
import { SERVICES_ONE_SHEET, ServicesPageList } from './DeploymentEnvironmentRows';
import { watchedServiceBands, watchedServiceItems, type WatchedMachineRead, type WatchedServiceItem } from './watchedServiceItems';
import { useReportViewCount, type ServicesViewCount } from './ServicesViews';

const NO_OPEN = () => {};
const CHECK_KINDS = ['configuredCheck'] as const;
const WATCHED_KINDS = ['watchedService'] as const;

/** The uptime figure alone, under the Last 30 days column that already says the span. */
function uptimePercentText(percent: number | null): string | null {
  return percent === null ? null : `${Math.round(percent * 10) / 10}%`;
}

/** The inventory's own coverage words: reading, or why a family could not be read. Never "none" for an unread list. */
function familyState(state: ManagedInventorySectionsState, kind: 'configuredCheck' | 'watchedService', testID: string): React.ReactNode | null {
  const family = state.families.find((candidate) => candidate.kind === kind);
  if (!family || family.result.coverage === 'available') return null;
  if (family.result.coverage === 'loading')
    return (
      <ItemGroup surface="none" testID={`${testID}.loading`}>
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  if ('unavailable' in family.result.coverage) {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID={`${testID}.unavailable`}
          kind="unavailable"
          size="line"
          title={t('projects.deployments.unavailableTitle')}
        />
      </ItemGroup>
    );
  }
  // Partly read with nothing listed (a Machine not read yet) is not "none": the inventory's own coverage line, never the
  // empty scene. With rows listed, a partial read is about their facts (a Check's results), so nothing is added.
  if (family.result.rows.length > 0) return null;
  return <ManagedInventoryCoverage families={[family]} testIDPrefix={testID} />;
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
  const input = React.useMemo(
    () => ({ scope: props.scope, machine: null, projectKey: null }),
    [props.scope],
  );
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
        const pending = familyState(state, 'configuredCheck', 'services.checks');
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
        return (
          <>
            {pending}
            <SelectedRowReport rows={rows} selectedKey={props.selectedKey} onSelectedRow={props.onSelectedRow} />
            <ChecksList rows={rows} input={input} selectedKey={props.selectedKey} onSelect={props.onSelect}
              onCount={props.onCount} />
          </>
        );
      }}
    </MachineManagedInventorySection>
  );
}


/** Publishes the selected row whenever its identity changes (a new result), so the pane shows current facts. */
function SelectedRowReport(props: Readonly<{ rows: readonly ManagedConfiguredCheckRow[]; selectedKey: string | null;
  onSelectedRow: (row: ManagedConfiguredCheckRow | null) => void }>) {
  const row = props.selectedKey ? props.rows.find((candidate) => candidate.key === props.selectedKey) ?? null : null;
  const { onSelectedRow } = props;
  React.useEffect(() => { onSelectedRow(row); }, [onSelectedRow, row]);
  return null;
}

/**
 * The Checks list (lab svcChk): one row per saved Check with its description, the lowest 30-day uptime its results
 * report and its state word, on the Services list's one sheet; the open Check is the selected row.
 */
function ChecksList(props: Readonly<{
  rows: readonly ManagedConfiguredCheckRow[];
  input: Readonly<{ scope: ServerAccountScope | null; machine: null; projectKey: null }>;
  selectedKey: string | null;
  onSelect: (row: ManagedConfiguredCheckRow) => void;
  onCount: (count: ServicesViewCount) => void;
}>) {
  const { theme } = useUnistyles();
  const { rows, onSelect } = props;
  const facts = React.useMemo(() => new Map(rows.map((row) => [row.key, readServiceCheckFacts(row.lastResults)])), [rows]);
  // Each row named by what it checks, with its kind, cadence and latest result (the Check presentation owner).
  const listFacts = React.useMemo(() => new Map(rows.map((row) => [row.key, serviceCheckListFacts(row)])), [rows]);
  const open = React.useCallback((key: string | number | null) => {
    const row = key === null ? undefined : rows.find((candidate) => candidate.key === String(key));
    if (row) onSelect(row);
  }, [onSelect, rows]);
  const model = useHappierCollection<ManagedConfiguredCheckRow>({ items: rows, keyOf: keyOfCheck,
    openKey: props.selectedKey, onOpenChange: open });
  const anatomy = React.useMemo<CollectionAnatomy<ManagedConfiguredCheckRow>>(() => {
    const meta = { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 } as const;
    const stateWord = (row: ManagedConfiguredCheckRow) => <CheckStateWord row={row} status={facts.get(row.key)?.status ?? 'unknown'} />;
    return {
      glyph: (row) => <RowMark row={row} title={row.native.name} input={props.input} />,
      title: (row) => listFacts.get(row.key)?.title ?? row.native.name,
      // Line 2 says what kind of check it is and its saved name; a phone also says its cadence and latest result.
      byline: (row, layout) => {
        const row2 = listFacts.get(row.key);
        const columns = layout?.fieldColumns === true;
        const named = row2 && row2.title !== row.native.name ? row.native.name : null;
        const line = [row2?.kind, named, columns ? null : row2?.every, columns ? null : row2?.lastResult]
          .filter(Boolean).join(' · ');
        return line ? <Text style={meta} numberOfLines={1}>{line}</Text> : null;
      },
      titleMeta: stateWord,
      titleMetaAlign: 'row',
      fields: [
        { key: 'every', title: t('projects.deployments.services.columnEvery'), minWidth: 72, priority: 2,
          listColumn: true, render: (row) => listFacts.get(row.key)?.every ?? null },
        { key: 'lastResult', title: t('projects.deployments.services.lastResult'), minWidth: 160, priority: 3,
          listColumn: true, render: (row) => listFacts.get(row.key)?.lastResult ? <CheckLastResult facts={listFacts.get(row.key)!} /> : null },
        { key: 'uptime', title: t('projects.deployments.services.columnUptime'), minWidth: 112, priority: 1, align: 'end',
          listColumn: true, render: (row) => uptimePercentText(facts.get(row.key)?.uptimePercent ?? null) },
        { key: 'state', title: t('projects.deployments.services.columnState'), minWidth: 128, priority: 4, align: 'end',
          listColumn: true, render: stateWord },
      ],
      accessibilityLabel: (row) => [listFacts.get(row.key)?.title ?? row.native.name, serviceCheckStatusWord(facts.get(row.key)?.status ?? 'unknown')].join(', '),
      testID: (row) => `services.checks.row.${row.automationId}.${row.triggerId}`,
      columnTitles: { title: t('projects.deployments.services.columnCheck') },
    };
  }, [facts, listFacts, props.input, theme.colors.text.secondary]);
  const failing = rows.filter((row) => row.native.enabled && facts.get(row.key)?.status === 'down').length;
  const count = React.useMemo(() => [t('projects.deployments.services.countChecks', { count: rows.length }),
    failing > 0 ? t('projects.deployments.services.countFailing', { count: failing }) : null], [failing, rows.length]);
  useReportViewCount('checks', count, props.onCount, failing);
  return (
    <ServicesPageList<ManagedConfiguredCheckRow> testID="services.checks" model={model} anatomy={anatomy}
      accessibilityLabel={t('projects.deployments.services.checks')} />
  );
}
const keyOfCheck = (row: ManagedConfiguredCheckRow) => row.key;

/** A Check's latest result in its tone (lab "502 · 1.2 s" rose); nothing yet draws the column's dash. */
function CheckLastResult(props: Readonly<{ facts: ReturnType<typeof serviceCheckListFacts> }>) {
  if (!props.facts.lastResult) return null;
  return props.facts.lastTone
    ? <Status tone={props.facts.lastTone} label={props.facts.lastResult} presentation="inline" />
    : <Text style={{ ...Typography.variant('meta') }} numberOfLines={1}>{props.facts.lastResult}</Text>;
}

/** A Check's state word from its results: failing and degraded speak, a switched-off Check says so quietly. */
function CheckStateWord(props: Readonly<{ row: ManagedConfiguredCheckRow; status: ServiceCheckStatus }>) {
  if (!props.row.native.enabled) return <Status tone="muted" label={t('projects.deployments.healthNotChecked')} presentation="inline" />;
  return <Status tone={serviceCheckStatusTone(props.status) ?? 'secondary'} label={serviceCheckStatusWord(props.status)} presentation="inline" />;
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
      {(state) =>
        state.rows.length === 0 ? (
          (familyState(state, 'watchedService', 'services.watched') ?? (
            <EmptyState
              testID="services.watched.empty"
              layout="page"
              scene="nothingListening"
              title={t('projects.deployments.services.noWatched')}
              subtitle={t('projects.deployments.services.noWatchedBody')}
            />
          ))
        ) : (
          <WatchedList state={state} serverId={props.scope?.serverId ?? null} presented={props.presented}
            onCount={props.onCount} />
        )
      }
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
      ...(band.read === 'failed' ? { description: t('machineServices.error.title'), tone: 'attention' as const }
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
    return band?.read === 'failed' && refresh ? { label: t('common.retry'), onPress: refresh, kind: 'operation' as const } : null;
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
      ? <MachineServiceByline row={item.service} runFactsInColumns={layout?.fieldColumns === true}
          stateInColumn={layout?.fieldColumns === true} />
      : <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 }} numberOfLines={1}>
          {t(`machineServices.purpose.${item.lifecyclePurpose === 'infrastructure' ? 'infrastructure' : 'watched'}`)}
        </Text>,
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
  React.useEffect(() => {
    // Still reading reports nothing; a read that answered or failed reports its rows (the last listed ones on failure).
    if (rows !== null || failed) onRead(machineId, { status: failed ? 'failed' : 'listed', rows });
  }, [failed, machineId, onRead, rows]);
  return null;
}
