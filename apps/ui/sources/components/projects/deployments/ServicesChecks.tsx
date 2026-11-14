import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { MachineManagedInventorySection } from '@/components/machines/page/MachineManagedInventorySection';
import { ManagedInventoryCoverage } from '@/components/store/inventory/ManagedInventoryCoverage';
import { RowMark } from '@/components/store/inventory/ManagedInventoryDirectory';
import type { ManagedInventorySectionsState } from '@/components/store/inventory/ManagedInventorySections';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Status, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MachineServiceByline, machineServiceColumnFields, renderMachineServicePort } from '@/components/machines/services/machineServiceColumns';
import { machineServiceDisplayName, machineServiceIcon } from '@/components/machines/services/machineServicesPresentation';
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
  type ServiceCheckStatus,
} from './serviceCheckPresentation';
import { serviceCheckStatusWord } from './ServiceCheckDetail';
import { SERVICES_ONE_SHEET, ServicesPageList } from './DeploymentEnvironmentRows';
import { useReportViewCount, type ServicesViewCount } from './ServicesViews';

const NO_OPEN = () => {};
const CHECK_KINDS = ['configuredCheck'] as const;
const WATCHED_KINDS = ['watchedService'] as const;

/** The uptime figure alone, under the Last 30 days column that already says the span. */
function uptimePercentText(percent: number | null): string | null {
  return percent === null ? null : `${Math.round(percent * 10) / 10}%`;
}

function uptimeText(percent: number | null): string | null {
  return percent === null
    ? null
    : t('projects.deployments.services.uptime', {
        percent: `${Math.round(percent * 10) / 10}%`,
      });
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
  // Partly read (a Machine not read yet) is not "none": the inventory's own coverage line, never the empty scene.
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
      title: (row) => row.native.name,
      // Line 2 says what it checks; a phone also says its uptime.
      byline: (row, layout) => {
        const uptime = layout?.fieldColumns === true ? null : uptimeText(facts.get(row.key)?.uptimePercent ?? null);
        const line = [row.native.description, uptime].filter(Boolean).join(' · ');
        return line ? <Text style={meta} numberOfLines={1}>{line}</Text> : null;
      },
      titleMeta: stateWord,
      titleMetaAlign: 'row',
      fields: [
        { key: 'uptime', title: t('projects.deployments.services.columnUptime'), minWidth: 160, priority: 2, align: 'end',
          listColumn: true, render: (row) => uptimePercentText(facts.get(row.key)?.uptimePercent ?? null) },
        { key: 'state', title: t('projects.deployments.services.columnState'), minWidth: 128, priority: 1, align: 'end',
          listColumn: true, render: stateWord },
      ],
      accessibilityLabel: (row) => [row.native.name, serviceCheckStatusWord(facts.get(row.key)?.status ?? 'unknown')].join(', '),
      testID: (row) => `services.checks.row.${row.automationId}.${row.triggerId}`,
      columnTitles: { title: t('projects.deployments.services.columnCheck') },
    };
  }, [facts, props.input, theme.colors.text.secondary]);
  const failing = rows.filter((row) => row.native.enabled && facts.get(row.key)?.status === 'down').length;
  const count = React.useMemo(() => [t('projects.deployments.services.countChecks', { count: rows.length }),
    failing > 0 ? t('projects.deployments.services.countFailing', { count: failing }) : null], [failing, rows.length]);
  useReportViewCount('checks', count, props.onCount);
  return (
    <ServicesPageList<ManagedConfiguredCheckRow> testID="services.checks" model={model} anatomy={anatomy}
      accessibilityLabel={t('projects.deployments.services.checks')} />
  );
}
const keyOfCheck = (row: ManagedConfiguredCheckRow) => row.key;

/** A Check's state word from its results: failing and degraded speak, a switched-off Check says so quietly. */
function CheckStateWord(props: Readonly<{ row: ManagedConfiguredCheckRow; status: ServiceCheckStatus }>) {
  if (!props.row.native.enabled) return <Status tone="muted" label={t('projects.deployments.healthNotChecked')} presentation="inline" />;
  const tone = props.status === 'down' ? 'danger' : props.status === 'degraded' ? 'warning' : 'secondary';
  return <Status tone={tone} label={serviceCheckStatusWord(props.status)} presentation="inline" />;
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

type WatchedItem = Readonly<{
  key: string;
  machineId: string;
  name: string;
  nativeResourceId: string;
  service: MachineServiceRowV1 | null;
  href: string | null;
}>;
const keyOfWatched = (item: WatchedItem) => item.key;
const groupOfWatched = (item: WatchedItem) => item.machineId;
const NO_SERVICE_LISTS: ReadonlyMap<string, readonly MachineServiceRowV1[]> = new Map();

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
  const [lists, setLists] = React.useState(NO_SERVICE_LISTS);
  const report = React.useCallback((machineId: string, rows: readonly MachineServiceRowV1[] | null) => {
    setLists((current) => {
      if (rows === null || current.get(machineId) === rows) return current;
      const next = new Map(current);
      next.set(machineId, rows);
      return next;
    });
  }, []);
  const items = React.useMemo<readonly WatchedItem[]>(() => watches.map((row) => ({
    key: row.key,
    machineId: row.machineId,
    name: row.native.name,
    nativeResourceId: row.native.nativeResourceId,
    service: lists.get(row.machineId)?.find((service) => service.serviceId === row.native.watchId
      || service.nativeInstance?.nativeResourceId === row.native.nativeResourceId) ?? null,
    href: (props.state.presentations.get(row.key)?.home.href as string | undefined) ?? null,
  })), [lists, props.state.presentations, watches]);
  const groups = React.useMemo(() => ({
    axis: machineIds.map((machineId) => ({ key: machineId, title: names[machineId] ?? t('machineServices.groups.watched'),
      section: SERVICES_ONE_SHEET })),
    groupOf: groupOfWatched,
  }), [machineIds, names]);
  const open = React.useCallback((key: string | number | null) => {
    const item = key === null ? undefined : items.find((candidate) => candidate.key === String(key));
    if (item?.href) router.push(item.href as never);
  }, [items, router]);
  const model = useHappierCollection<WatchedItem>({ items, keyOf: keyOfWatched, groups, openKey: null, onOpenChange: open });
  const anatomy = React.useMemo<CollectionAnatomy<WatchedItem>>(() => ({
    glyph: (item) => <Icon name={item.service ? machineServiceIcon(item.service) : 'eye'} size={ICON_SIZE.md}
      color={theme.colors.text.secondary} />,
    title: (item) => item.service ? machineServiceDisplayName(item.service) : item.name,
    byline: (item, layout) => item.service
      ? <MachineServiceByline row={item.service} runFactsInColumns={layout?.fieldColumns === true} />
      : <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 }} numberOfLines={1}>
          {item.nativeResourceId}
        </Text>,
    titleMeta: (item) => item.service ? renderMachineServicePort(item.service) : null,
    titleMetaAlign: 'row',
    fields: machineServiceColumnFields<WatchedItem>((item) => item.service),
    accessibilityLabel: (item) => [item.service ? machineServiceDisplayName(item.service) : item.name, names[item.machineId]]
      .filter(Boolean).join(', '),
    testID: (item) => `services.watched.row.${item.key}`,
    columnTitles: { title: t('machineServices.columns.service') },
  }), [names, theme.colors.text.secondary]);
  const count = React.useMemo(() => [t('projects.deployments.services.countWatched',
    { services: items.length, machines: machineIds.length })], [items.length, machineIds.length]);
  useReportViewCount('watched', count, props.onCount);
  return (
    <>
      {props.serverId ? machineIds.map((machineId) => (
        <WatchedMachineReader key={machineId} serverId={props.serverId!} machineId={machineId} active={props.presented}
          onRows={report} />
      )) : null}
      <ServicesPageList<WatchedItem> testID="services.watched" model={model} anatomy={anatomy}
        accessibilityLabel={t('projects.deployments.services.watched')} />
    </>
  );
}

/** One Machine's service read (no UI of its own), reported up so the Watched rows draw its facts. */
function WatchedMachineReader(props: Readonly<{ serverId: string; machineId: string; active: boolean;
  onRows: (machineId: string, rows: readonly MachineServiceRowV1[] | null) => void }>) {
  const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId, active: props.active });
  const { onRows, machineId } = props;
  React.useEffect(() => { onRows(machineId, list.rows ?? null); }, [list.rows, machineId, onRows]);
  return null;
}
