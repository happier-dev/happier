import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  Status,
  useHappierCollection,
  type CollectionAnatomy,
} from '@happier-dev/plugin-ui';
import type {
  MachineServiceRowV1,
  ManagedServiceUnavailableReasonV1,
} from '@happier-dev/protocol';

import type {
  MachinePageTabBodyProps,
  MachinePageTabParams,
} from '@/components/machines/page/machinePageTabQuery';
import { MachinePortActionsProvider } from '@/components/machines/localServices/MachinePortActions';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { describeMachineUptime, describeMachineUptimeSpan } from '@/components/machines/vitals/vitalsFormat';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  compareMachineServices,
  machineServiceEnvironmentIds,
  machineServiceGroupEnvironmentId,
  machineServiceGroupKeys,
  machineServiceIcon,
  machineServiceGroupOf,
  machineServiceIdentityLine,
  machineServiceStateSpeaks,
  machineServiceHealthQualifier,
  machineServiceStateTone,
  machineServiceRunFacts,
  machineServiceExpectedStop,
} from './machineServicesPresentation';
import { useMachineDeploymentRoles, useMachineServiceEnvironments, useMachineServiceSourceName } from './useMachineServiceEnvironments';
import { MachineDeploymentRolesSection, machineDeploymentRoleRows } from './MachineDeploymentRolesSection';
import { MachineServicePage } from './MachineServicePage';
import { MachineServiceWatchMenu } from './MachineServiceWatchMenu';
import {
  useMachineServicesList,
  type MachineServicesListState,
} from './useMachineServices';

type ServicesParams = Extract<MachinePageTabParams, { id: 'services' }>;

/**
 * Machine → Services (plan 30 S30-6e, lab `machine/services/list` + `detail`): what runs on this Machine for the person,
 * grouped by who keeps it, each opening its own page with its state and logs. One read of the admitted rows while the
 * tab is shown; the last good list stays readable under a freshness line when a later read fails.
 */
export function MachineServicesTab(props: MachinePageTabBodyProps) {
  return (
    <MachinePortActionsProvider serverId={props.serverId} machineId={props.machineId}>
      <MachineServicesTabBody {...props} />
    </MachinePortActionsProvider>
  );
}

function MachineServicesTabBody(props: MachinePageTabBodyProps) {
  const params = props.params as ServicesParams;
  const presented = useLayoutPresentationActive();
  const list = useMachineServicesList({
    serverId: props.serverId,
    machineId: props.machineId,
    active: presented,
  });
  const setParams = props.setParams;
  const open = React.useCallback(
    (serviceId: string | null) => {
      setParams(
        serviceId === null
          ? { id: 'services' }
          : { id: 'services', page: 'service', service: serviceId },
      );
    },
    [setParams],
  );
  if (params.page === 'roles') {
    return <MachineDeploymentRolesPage {...props} active={presented} onBack={() => open(null)} />;
  }
  if (params.page === 'service' && params.service) {
    const service =
      list.rows?.find((row) => row.serviceId === params.service) ?? null;
    return (
      <MachineServicePage
        serverId={props.serverId}
        machineId={props.machineId}
        machineName={props.machineName}
        serviceId={params.service}
        service={service}
        list={list.rows ? 'listed' : list.pending || (!list.error && !list.unavailable) ? 'reading' : 'failed'}
        online={props.online}
        readAt={list.readAt}
        refreshing={list.pending}
        onRetry={() => { void list.refresh(); }}
        active={presented}
        onBack={() => open(null)}
      />
    );
  }
  return <MachineServicesList {...props} list={list} active={presented} onOpen={open} />;
}

function MachineServicesList(
  props: MachinePageTabBodyProps &
    Readonly<{
      list: MachineServicesListState &
        Readonly<{ refresh: () => Promise<void> }>;
      active: boolean;
      onOpen: (serviceId: string | null) => void;
    }>,
) {
  const { theme } = useUnistyles();
  const { list, machineName, setParams } = props;
  const rows = list.rows ?? NO_ROWS;
  // Each Environment deployed here is its own group, named "<Source> · <Environment>" from the admitted headers of
  // exactly the visible Environments, and each Source's name read once (plan 30 §3.8).
  const environmentIds = React.useMemo(() => machineServiceEnvironmentIds(rows), [rows]);
  const environments = useMachineServiceEnvironments({ serverId: props.serverId, environmentIds, active: props.active });
  // The Machine's exact deployment roles (controller, build, edge…) come from the canonical reference census, which
  // answers even when nothing runs here; never from service names.
  const roles = useMachineDeploymentRoles({ serverId: props.serverId, machineId: props.machineId, active: props.active });
  const sourceIds = React.useMemo(() => [...new Set([...environments.headers.values(),
    ...machineDeploymentRoleRows(roles.environments)].map(header => header.projectSourceId))].sort(),
    [environments, roles.environments]);
  const { sourceNames, readers: sourceNameReaders } = useSourceNames(props.serverId, sourceIds, props.active);
  const groups = React.useMemo(
    () => {
      // One "Deployed by Happier" section holds every Environment here, each its own "<Source> · <Environment>"
      // sub-group on the section's one sheet (lab `services/list`).
      const deployed = { key: 'deployed', title: t('machineServices.groups.deployed'),
        detail: t('machineServices.groups.environments', { count: environmentIds.length }) };
      return {
      axis: machineServiceGroupKeys(rows).map((key) => {
        const environmentId = machineServiceGroupEnvironmentId(key);
        if (environmentId === null) {
          const fixed = key as Exclude<typeof key, `environment:${string}`>;
          return {
            key,
            title: t(`machineServices.groups.${fixed}`),
            ...(fixed === 'infrastructure' ? { description: t('machineServices.groups.infrastructureDescription') } : {}),
          };
        }
        // Until its header is read the sub-group says so; one the person can't read says that. Never an id.
        const header = environments.headers.get(environmentId);
        const source = header ? sourceNames.get(header.projectSourceId) : undefined;
        return {
          key,
          title: header ? (source ? `${source} · ${header.title}` : header.title)
            : environments.settled ? t('machineServices.groups.environmentUnavailable') : t('machineServices.groups.environmentReading'),
          section: deployed,
        };
      }),
      groupOf: (row: MachineServiceRowV1) => machineServiceGroupOf(row),
      };
    },
    [rows, environmentIds.length, environments, sourceNames],
  );
  const model = useHappierCollection<MachineServiceRowV1>({
    items: rows,
    keyOf: keyOfRow,
    groups,
    order: compareMachineServices,
    openKey: null,
    onOpenChange: (key) => {
      if (key !== null) props.onOpen(String(key));
    },
  });
  const anatomy = React.useMemo<CollectionAnatomy<MachineServiceRowV1>>(
    () => ({
      glyph: (row) => (
        <Icon
          name={machineServiceIcon(row)}
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      ),
      title: (row) => row.name,
      // Line 2 (lab `services/list`): the state only when it needs the person, then what the service is and the native
      // instance it watches ("systemd · caddy.service"). Nothing is shown that the producer doesn't supply.
      // On a wide page Memory and Up stand in their own columns; a phone's row says them here instead.
      byline: (row, layout) => <MachineServiceByline row={row} runFactsInColumns={layout?.fieldColumns === true} />,
      // The port it listens on: a mono chip in the row's end column on a phone, the Ports column on a wide page.
      titleMeta: renderServicePort,
      titleMetaAlign: 'row',
      // Ports, Memory and Up line up in tabular columns (lab `services/list`); the shared list drops them on a phone.
      fields: [
        { key: 'port', title: t('machineServices.columns.port'), render: renderServicePort, minWidth: 64, priority: 3, listColumn: true },
        { key: 'memory', title: t('machineServices.columns.memory'), align: 'end', minWidth: 64, priority: 2, listColumn: true,
          render: (row) => {
            const memoryBytes = machineServiceRunFacts(row, Date.now()).memoryBytes;
            return memoryBytes === null ? null : formatMachineBytes(memoryBytes, 'memory');
          } },
        { key: 'up', title: t('machineServices.columns.up'), align: 'end', minWidth: 64, priority: 1, listColumn: true,
          render: (row) => {
            const upMs = machineServiceRunFacts(row, Date.now()).upMs;
            return upMs === null ? null : describeMachineUptimeSpan(Date.now() - upMs, Date.now());
          } },
      ],
      accessibilityLabel: (row) =>
        `${row.name}, ${t(`machineServices.state.${row.state}`)}`,
      testID: (row) => `machine-service-${row.serviceId}`,
      columnTitles: { title: t('machineServices.columns.service'), titleMeta: t('machineServices.columns.port') },
    }),
    [theme.colors.text.secondary],
  );

  const openRoles = React.useCallback(() => setParams({ id: 'services', page: 'roles' }), [setParams]);
  const description = t('machineServices.lede', { machine: machineName });
  // The last good list stays readable under one freshness line when a later read fails, or when the Machine stops
  // answering (its presence, from the Machine page): what it last listed may no longer be true (lab `services/offline`).
  const stale = list.rows && (list.error || props.online === false) ? (
    <SurfaceFreshnessLine
      testID="machine-services-stale"
      asOf={list.readAt}
      tone="warning"
      reason={t('machineServices.stale', { machine: machineName })}
      busy={list.pending}
      action={{ label: t('common.retry'), onPress: () => { void list.refresh(); } }}
    />
  ) : null;

  const state = readListState(list, props.online);
  // The page's one sentence leads on the tab's own edge, like Guard's sections; the table below keeps the contained
  // sheet the Processes table uses, so both read on one column edge (lab `services/list`).
  // A failed refresh says so under the sentence, over the rows it keeps showing.
  // An answered empty list lets its empty state say what the page is for (lab `services/empty`): the sentence would
  // only repeat it.
  const answeredEmpty = list.rows !== null && list.rows.length === 0 && !stale;
  // Nothing can be deployed to or watched on a Machine that isn't answering (lab `services/offline`).
  const head = answeredEmpty ? null : (
    <ItemGroup surface="none" description={description} testID="machine-services-lede" actionLayout="adaptive"
      action={props.online === false ? undefined : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
          <MachineServiceWatchMenu serverId={props.serverId} machineId={props.machineId} machineName={machineName} rows={rows} />
        </View>
      )}>
      {stale}
    </ItemGroup>
  );
  return (
    <View testID="machine-services">
      {sourceNameReaders}
      {head}
      <ListPresentationProvider value="page" pageInsets="contained">
        <ItemGroup header="none" surface="none">
          {state ? (
            <StateCard state={state} machineName={machineName} onRetry={() => { void list.refresh(); }} />
          ) : list.rows?.length === 0 ? (
            <SurfaceStateCard testID="machine-services-empty" kind="empty" iconName="hard-drives"
              title={t('machineServices.empty.title', { machine: machineName })}
              reason={t('machineServices.empty.body')}
              // With the sentence gone (answered empty) its two ways to add stand here, so the first Watch starts here too (lab `services/empty`).
              {...(answeredEmpty ? { actionFooter: <MachineServiceWatchMenu serverId={props.serverId} machineId={props.machineId} machineName={machineName} rows={rows} /> } : {})} />
          ) : (
            <CoreCollectionScope>
              <Collection<MachineServiceRowV1>
                testID="machine-services-table"
                model={model}
                anatomy={anatomy}
                accessibilityLabel={t('machineServices.tableLabel', { machine: machineName })}
                presentation="list"
                detail="none"
                scroll="page"
                minListWidth={0}
                minDetailWidth={0}
                preferredListRatio={1}
                loading={list.rows === null}
                loadingRows={3}
              />
            </CoreCollectionScope>
          )}
        </ItemGroup>
      </ListPresentationProvider>
      {/* Its own page section on the page's column edge, beside the sentence above (not inside the table's sheet).
          Beside listed services it is one row opening its own page; with none it lists every Environment (lab). */}
      <MachineDeploymentRolesSection serverId={props.serverId} machineName={machineName}
        environments={roles.environments} status={roles.status} sourceNames={sourceNames} onRetry={roles.refresh}
        presentation={rows.length > 0 ? 'summary' : 'section'} onOpenAll={openRoles} />
    </View>
  );
}

/**
 * Every Environment the Machine has a deployment role for, pushed from the Services list's one-row summary: the page
 * head names it and says what it is, then the full list.
 */
function MachineDeploymentRolesPage(props: MachinePageTabBodyProps & Readonly<{ active: boolean; onBack: () => void }>) {
  const roles = useMachineDeploymentRoles({ serverId: props.serverId, machineId: props.machineId, active: props.active });
  const sourceIds = React.useMemo(() => [...new Set(machineDeploymentRoleRows(roles.environments)
    .map(environment => environment.projectSourceId))].sort(), [roles.environments]);
  const { sourceNames, readers } = useSourceNames(props.serverId, sourceIds, props.active);
  return (
    <View testID="machine-services-roles-page">
      {readers}
      <MachineTabSubHead
        title={t('machineServices.roles.title')}
        back={{ label: t('machineServices.back'), onPress: props.onBack, testID: 'machine-services-roles-back' }}
        description={t('machineServices.roles.description', { machine: props.machineName })}
      />
      {roles.status === 'loading' && roles.environments.length === 0 ? (
        <ItemGroup surface="none">
          <SurfaceStateCard testID="machine-services-roles-loading" kind="loading" title={t('common.loading')} />
        </ItemGroup>
      ) : (
        <MachineDeploymentRolesSection serverId={props.serverId} machineName={props.machineName} presentation="page"
          environments={roles.environments} status={roles.status} sourceNames={sourceNames} onRetry={roles.refresh} />
      )}
    </View>
  );
}

/** The admitted names of these Sources, read once each, with the readers that keep them current (no UI of their own). */
function useSourceNames(serverId: string, sourceIds: readonly string[], active: boolean): Readonly<{
  sourceNames: ReadonlyMap<string, string>;
  readers: React.ReactNode;
}> {
  const [sourceNames, setSourceNames] = React.useState<ReadonlyMap<string, string>>(NO_NAMES);
  const onSourceName = React.useCallback((sourceId: string, name: string | null) => {
    setSourceNames(previous => {
      if ((previous.get(sourceId) ?? null) === name) return previous;
      const next = new Map(previous);
      if (name === null) next.delete(sourceId); else next.set(sourceId, name);
      return next;
    });
  }, []);
  const readers = sourceIds.map(sourceId => (
    <MachineServiceSourceNameReader key={sourceId} serverId={serverId} sourceId={sourceId} active={active} onName={onSourceName} />
  ));
  return { sourceNames, readers };
}

/** Reads one Source's admitted name for the groups (no UI of its own): one reader per distinct visible Source. */
function MachineServiceSourceNameReader(props: Readonly<{
  serverId: string; sourceId: string; active: boolean; onName: (sourceId: string, name: string | null) => void;
}>) {
  const name = useMachineServiceSourceName(props.serverId, props.sourceId, props.active);
  const { onName, sourceId } = props;
  React.useEffect(() => { onName(sourceId, name); }, [onName, sourceId, name]);
  return null;
}

/** The port a service listens on, as a mono chip: the phone row's end column and the wide page's Ports column. */
function renderServicePort(row: MachineServiceRowV1): React.ReactNode {
  return row.port == null ? null : <InlineCode testID={`machine-service-${row.serviceId}:port`}>{String(row.port)}</InlineCode>;
}

/** The list row's second line: the state only when it needs the person, then what the service is. */
function MachineServiceByline(props: Readonly<{ row: MachineServiceRowV1; runFactsInColumns: boolean }>) {
  const { row } = props;
  const { theme } = useUnistyles();
  const identity = machineServiceIdentityLine(row);
  // A running service its own health source hasn't verified says so quietly (lab: "running, no health check").
  const qualifier = machineServiceHealthQualifier(row);
  const health = qualifier ? t('machineServices.health.running', { health: t(`machineServices.health.${qualifier}`) }) : null;
  // What its source reported about the run (lab Memory and Up): only known values, never a zero for unknown.
  // Its own columns say them on a wide page.
  const run = props.runFactsInColumns ? NO_RUN_FACTS : machineServiceRunFacts(row, Date.now());
  const memory = run.memoryBytes === null ? null : formatMachineBytes(run.memoryBytes, 'memory');
  // Up reads like the Machine header's own Up ("Up 1 d 4 h"), from the service's last start.
  const up = run.upMs === null ? null : describeMachineUptime(Date.now() - run.upMs, Date.now());
  const native = [identity, health, memory, up].filter(Boolean).join(' · ') || null;
  // A stop the person asked for reads as that stop, quiet (lab `services/states` "Stopped by you"), never as a failure.
  const expectedStop = machineServiceExpectedStop(row);
  const speaks = expectedStop !== null || machineServiceStateSpeaks(row.state);
  if (!speaks && !native) return null;
  return (
    // Bounded to the row's text column so a long line ends in an ellipsis at the card edge on a phone, never past it;
    // the full facts are on the service's page.
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0, maxWidth: '100%', alignSelf: 'stretch' }}>
      {speaks ? (
        <Status
          tone={expectedStop ? 'secondary' : machineServiceStateTone(row.state)}
          label={expectedStop ? t(`machineServices.expectedDown.${expectedStop}`) : t(`machineServices.state.${row.state}`)}
          presentation="inline"
        />
      ) : null}
      {native ? <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 }} numberOfLines={1}>
        {speaks ? `· ${native}` : native}
      </Text> : null}
    </View>
  );
}

type ListState =
  | Readonly<{ kind: 'offline' }>
  | Readonly<{ kind: 'unavailable'; reason: ManagedServiceUnavailableReasonV1 }>
  | Readonly<{ kind: 'error'; code: string }>;

/** A state replaces the table only when there are no rows to keep showing. */
function readListState(
  list: MachineServicesListState,
  online: boolean | null,
): ListState | null {
  // A retry shows its progress where the rows will be (the skeleton), not the failure it is replacing.
  if (list.rows || list.pending) return null;
  if (list.unavailable)
    return { kind: 'unavailable', reason: list.unavailable };
  if (list.error)
    return online === false
      ? { kind: 'offline' }
      : { kind: 'error', code: list.error.code };
  return null;
}

function StateCard(
  props: Readonly<{
    state: ListState;
    machineName: string;
    onRetry: () => void;
  }>,
) {
  const { state, machineName } = props;
  const retry = {
    label: t('common.retry'),
    onPress: props.onRetry,
    testID: 'machine-services-retry',
  };
  if (state.kind === 'offline') {
    return (
      <SurfaceStateCard
        testID="machine-services-offline"
        kind="unavailable" iconName="wifi-slash"
        title={t('machineServices.offline.title', { machine: machineName })}
        reason={t('machineServices.offline.body')}
      />
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <SurfaceStateCard
        testID={`machine-services-unavailable-${state.reason}`}
        kind="unavailable"
        title={t('machineServices.unavailable.title', { machine: machineName })}
        reason={
          state.reason === 'unsupported'
            ? t('machineServices.unavailable.unsupported')
            : t('machineServices.unavailable.body')
        }
        diagnosticCode={state.reason}
        {...(state.reason === 'unsupported' ? {} : { action: retry })}
      />
    );
  }
  return (
    <SurfaceStateCard
      testID="machine-services-error"
      kind="error"
      title={t('machineServices.error.title')}
      reason={t('machineServices.error.body', { machine: machineName })}
      diagnosticCode={state.code}
      action={retry}
    />
  );
}

const NO_ROWS: readonly MachineServiceRowV1[] = [];
const NO_RUN_FACTS = Object.freeze({ memoryBytes: null, upMs: null });
const NO_NAMES: ReadonlyMap<string, string> = new Map();
const keyOfRow = (row: MachineServiceRowV1) => row.serviceId;
