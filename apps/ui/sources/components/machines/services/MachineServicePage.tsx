import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import { useMachinePortEntry } from '@/components/machines/localServices/MachinePortActions';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MachineServiceLogs } from './MachineServiceLogs';
import { showMachineServiceAdoption } from './adoption/MachineServiceAdoptionSheet';
import { canAdoptMachineService } from './adoption/machineServiceAdoptionPresentation';
import {
  machineServiceControls,
  machineServiceDeclaredFacts,
  machineServiceGroupEnvironmentId,
  machineServiceGroupOf,
  machineServiceHealthQualifier,
  machineServiceIcon,
  machineServiceIdentityLine,
  machineServiceStateTone,
  machineServiceRunFacts,
  machineServiceExpectedStop,
  isMachineServiceRestart,
} from './machineServicesPresentation';
import {
  useMachineServiceControl,
  useMachineServiceDetail,
  type MachineServiceControlOutcome,
  type MachineServiceDetailFacts,
} from './useMachineServiceDetail';
import { useMachineServiceEnvironments, useMachineServiceSourceName } from './useMachineServiceEnvironments';

/**
 * One service on a Machine (lab `machine/services/detail`), pushed inside the Services tab like Storage's and Guard's
 * pages: its name and who keeps it, its state in one sentence, then its logs, which are the page's reason to exist.
 */
export function MachineServicePage(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    serviceId: string;
    /** The admitted row; null while the list is read, or when it no longer lists this service. */
    service: MachineServiceRowV1 | null;
    /** Whether the list answered: only a list that answered without this service says it is gone. */
    list: 'reading' | 'listed' | 'failed';
    /** The Machine's presence: while it isn't answering the page is what it last reported, and offers no control. */
    online: boolean | null;
    readAt: number | null;
    refreshing: boolean;
    onRetry: () => void;
    active: boolean;
    onBack: () => void;
  }>,
) {
  const { service, machineName } = props;
  const back = {
    label: t('machineServices.back'),
    onPress: props.onBack,
    testID: 'machine-service-back',
  };
  if (!service) {
    return (
      <View testID="machine-service-page">
        <MachineTabSubHead title={null} back={back} />
        <ListPresentationProvider value="page" pageInsets="contained">
          {props.list === 'listed' ? (
            <SurfaceStateCard
              testID="machine-service-gone"
              kind="unavailable"
              title={t('machineServices.gone.title', { machine: machineName })}
              reason={t('machineServices.gone.body')}
              action={{ label: t('machineServices.back'), onPress: props.onBack }}
            />
          ) : props.list === 'failed' ? (
            <SurfaceStateCard
              testID="machine-service-error"
              kind="error"
              title={t('machineServices.error.title')}
              reason={t('machineServices.error.body', { machine: machineName })}
              action={{ label: t('common.retry'), onPress: props.onRetry }}
            />
          ) : (
            <SurfaceStateCard testID="machine-service-loading" kind="loading" title={t('machineServices.loading')} />
          )}
        </ListPresentationProvider>
      </View>
    );
  }
  return (
    <MachineServicePresent
      serverId={props.serverId}
      machineId={props.machineId}
      machineName={machineName}
      service={service}
      active={props.active}
      back={back}
      offline={props.online === false}
      stale={props.online === false ? (
        <SurfaceFreshnessLine
          testID="machine-service-stale"
          asOf={props.readAt}
          tone="warning"
          reason={t('machineServices.staleService', { machine: machineName })}
          busy={props.refreshing}
          action={{ label: t('common.retry'), onPress: props.onRetry }}
        />
      ) : null}
    />
  );
}

/**
 * The service itself (lab `services/detail`): its mark and name, what it is and who keeps it on one quiet line, its
 * one visible control (Restart; Stop and Start in ⋯), its facts, then its logs. Healthy reads as a plain fact.
 */
function MachineServicePresent(props: Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  service: MachineServiceRowV1;
  active: boolean;
  back: Readonly<{ label: string; onPress: () => void; testID: string }>;
  offline: boolean;
  stale: React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const { service, machineName } = props;
  const group = machineServiceGroupOf(service);
  const environmentId = machineServiceGroupEnvironmentId(group);
  const environmentIds = React.useMemo(() => environmentId ? [environmentId] : NO_IDS, [environmentId]);
  const environments = useMachineServiceEnvironments({ serverId: props.serverId, environmentIds, active: props.active });
  const header = environments.headers.get(environmentId ?? '') ?? null;
  const sourceName = useMachineServiceSourceName(props.serverId, header?.projectSourceId ?? null, props.active);
  const keeper = environmentId === null
    ? t(`machineServices.purpose.${group as Exclude<typeof group, `environment:${string}`>}`)
    : header ? (sourceName ? `${sourceName} · ${header.title}` : header.title)
      : environments.settled ? t('machineServices.groups.environmentUnavailable') : t('machineServices.groups.deployed');
  const identity = machineServiceIdentityLine(service);
  // Who keeps it leads for a deployed service ("shop · Production · Compose"), trails for a watched one
  // ("systemd · postgresql@16-main.service · watched").
  const meta = (environmentId === null ? [identity, keeper] : [keeper, identity]).filter(Boolean).join(' · ');
  const detail = useMachineServiceDetail({ serverId: props.serverId, machineId: props.machineId,
    serviceId: service.serviceId, generation: service.generation, active: props.active });
  const control = useMachineServiceControl({ serverId: props.serverId, machineId: props.machineId, service });
  const offered = machineServiceControls(service);
  // One visible control (lab `services/detail`): Restart, or Start when the service is down; the rest sit in ⋯.
  // A Machine that isn't answering can't act on its services, so none of them is offered.
  const visible = props.offline ? null : offered.restart ? 'restart' as const : offered.start ? 'start' as const : null;
  const menuStart = !props.offline && offered.start && visible !== 'start';
  const menuStop = !props.offline && offered.stop;
  const facts = React.useMemo(() => serviceFacts(service, detail), [service, detail]);
  // A process start proves running since; only a health transition proves healthy since.
  const healthSince = service.health?.since;
  const runningSince = service.state === 'running' || service.state === 'healthy' ? service.accounting?.startedAtMs : undefined;
  const sinceMs = healthSince ?? runningSince;
  const since = sinceMs === undefined ? null : t('machineServices.healthSince', {
    state: t(`machineServices.state.${healthSince === undefined ? 'running' : service.state}`),
    since: formatWithCachedDateTimeFormatter(sinceMs, undefined, SINCE_FORMAT),
  });
  const portOpen = useServicePortOpen(props.offline ? null : service.port ?? null);
  // A watched Compose project leads with adopting it (lab `services/adopt`); a Machine that isn't answering can't capture it.
  const adoptable = canAdoptMachineService(service);
  const adopt = adoptable && !props.offline;
  return (
    <View testID="machine-service-page">
      <MachineTabSubHead
        title={service.name}
        mark={<Icon name={machineServiceIcon(service)} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
        back={props.back}
        description={meta || null}
      >
        {visible || portOpen || adopt ? (
          <View style={styles.controls} testID="machine-service-controls">
            {adopt ? (
              <RoundButton
                testID="machine-service-adopt"
                size="small"
                title={t('machineServices.adopt.action')}
                onPress={() => showMachineServiceAdoption({ serverId: props.serverId, machineId: props.machineId,
                  machineName, service })}
              />
            ) : null}
            {portOpen ? (
              <RoundButton
                testID="machine-service-open"
                size="small"
                display="secondary"
                title={t('machineServices.control.open')}
                accessibilityLabel={t('machineServices.control.openLabel', { service: service.name })}
                leading={<Icon name="arrow-square-out" size={14} color={theme.colors.text.primary} />}
                loading={portOpen.reading}
                disabled={portOpen.reading || portOpen.reason !== null}
                onPress={() => { if (portOpen.open) fireAndForget(portOpen.open(), { tag: 'MachineServices.portOpen' }); }}
              />
            ) : null}
            {visible ? <RoundButton
              testID={`machine-service-${visible}`}
              size="small"
              display="secondary"
              title={t(`machineServices.control.${visible}`)}
              accessibilityLabel={`${t(`machineServices.control.${visible}`)} ${service.name}`}
              leading={<Icon name={visible === 'restart' ? 'arrow-clockwise' : 'play'} size={14} color={theme.colors.text.primary} />}
              loading={control.pending === visible}
              disabled={control.pending !== null}
              onPress={() => control.run(visible)}
            /> : null}
            {menuStop || menuStart ? (
              <ServiceMoreMenu
                serviceName={service.name}
                stop={menuStop}
                start={menuStart}
                disabled={control.pending !== null}
                onRun={control.run}
              />
            ) : null}
          </View>
        ) : null}
      </MachineTabSubHead>
      <ItemGroup surface="none" header="none" testID="machine-service-state">
        {props.stale}
        {portOpen?.reason ? (
          <Text variant="meta" testID="machine-service-open-reason" style={[styles.outcome, { color: theme.colors.text.secondary }]}>
            {portOpen.reason}
          </Text>
        ) : null}
        {adoptable ? (
          <Text variant="body" testID="machine-service-watched-note" style={[styles.since, { color: theme.colors.text.secondary }]}>
            {t('machineServices.adopt.watchedNote', { service: service.name })}
          </Text>
        ) : null}
        {since === null ? null : (
          <Text variant="body" testID="machine-service-since" style={[styles.since, { color: theme.colors.text.secondary }]}>
            {since}
          </Text>
        )}
        <View style={styles.facts}>
          <FactStrip facts={facts} testID="machine-service-facts" />
        </View>
        {control.outcome ? (
          <Text variant="meta" testID="machine-service-control-outcome"
            style={[styles.outcome, control.outcome.kind === 'approval' ? null : { color: theme.colors.state.warning.foreground }]}>
            {controlOutcomeCopy(control.outcome, service.name, machineName)}
          </Text>
        ) : null}
      </ItemGroup>
      <ItemGroup
        title={t('machineServices.logs.title')}
        description={t('machineServices.logs.description', { service: service.name })}
        surface="none"
      >
        <MachineServiceLogs
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={machineName}
          service={service}
          active={props.active}
        />
      </ItemGroup>
    </View>
  );
}

/**
 * Open for a service that listens on a port (PAR-4): the shared port owner's Local services offer, the same one the
 * Processes port menu uses. Opening this page is the intent signal that reads Local services; a port they don't list
 * offers nothing, and a route this device lacks keeps Open visible with the owner's reason.
 */
function useServicePortOpen(port: number | null) {
  const entry = useMachinePortEntry({ port: port ?? 0 }, port !== null);
  const demand = port === null ? undefined : entry.actions?.demand;
  React.useEffect(() => { demand?.(); }, [demand]);
  if (port === null || !entry.actions) return null;
  const reading = !entry.services?.rows;
  if (!reading && !entry.open) return null;
  return { reading, open: entry.open, reason: reading ? null : entry.offered?.openUnavailableReason ?? null };
}

/** Stop and Start live in ⋯ beside Restart (lab `services/detail`): only the ones the service supports now. */
function ServiceMoreMenu(props: Readonly<{
  serviceName: string; stop: boolean; start: boolean; disabled: boolean;
  onRun: (operation: 'stop' | 'start') => void;
}>) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo((): readonly DropdownMenuItem[] => [
    ...(props.start ? [{ id: 'start', testID: 'machine-service-start', title: t('machineServices.control.start'),
      icon: <Icon name="play" size={16} color={theme.colors.text.secondary} /> }] : []),
    ...(props.stop ? [{ id: 'stop', testID: 'machine-service-stop', title: t('machineServices.control.stop'),
      icon: <Icon name="stop" size={16} color={theme.colors.text.secondary} /> }] : []),
  ], [props.start, props.stop, theme.colors.text.secondary]);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={t('common.more')}
      onSelect={(id) => { if (id === 'stop' || id === 'start') props.onRun(id); }}
      trigger={({ toggle }) => (
        <IconButton
          testID="machine-service-more"
          iconName="dots-three"
          variant="plain"
          disabled={props.disabled}
          accessibilityLabel={`${t('common.more')}: ${props.serviceName}`}
          onPress={toggle}
        />
      )}
    />
  );
}

function controlOutcomeCopy(outcome: MachineServiceControlOutcome, service: string, machine: string): string {
  switch (outcome.kind) {
    case 'approval': return t('machineServices.control.approval');
    case 'unknown': return t('machineServices.control.unknown', { machine });
    case 'unsupported': return t('machineServices.control.unsupported', { machine, service });
    case 'failed': return t('machineServices.control.failed', { service });
  }
}

/**
 * The service's facts (lab `fc-facts`), each only when its producer supplies it: health from the native source,
 * the port, memory from the detail's one accounting sample, and the declared Compose replicas, limits and restart
 * policy. Declared replicas are not an observed count; a missing counter says so instead of reading as zero.
 */
function serviceFacts(service: MachineServiceRowV1, detail: MachineServiceDetailFacts | null): FactStripFact[] {
  // Health is the service's state alone, in its tone; what kind of service it is stays on the identity line.
  // A running service its own health source hasn't verified says so beside Running; it never reads as healthy.
  const qualifier = machineServiceHealthQualifier(service);
  // A stop the person asked for is that stop, in no warning tone (lab `services/states` "Stopped by you").
  const expectedStop = machineServiceExpectedStop(service);
  const tone = expectedStop ? 'secondary' : qualifier === 'failing' || qualifier === 'degraded' ? 'warning' : machineServiceStateTone(service.state);
  const state = expectedStop ? t(`machineServices.expectedDown.${expectedStop}`) : t(`machineServices.state.${service.state}`);
  const facts: FactStripFact[] = [{
    key: 'health',
    label: t('machineServices.facts.health'),
    value: qualifier ? `${state} · ${t(`machineServices.health.${qualifier}`)}` : state,
    ...(tone === 'danger' ? { tone: 'danger' as const } : tone === 'warning' ? { tone: 'attention' as const } : {}),
  }];
  if (service.port != null) facts.push({ key: 'port', label: t('machineServices.facts.port'), value: String(service.port) });
  const samples = detail?.accounting?.kind === 'sample' ? detail.accounting.samples : null;
  const run = machineServiceRunFacts(service, Date.now());
  if (samples && samples.length > 0) {
    const known = samples.every(sample => sample.memoryBytes !== null);
    facts.push({ key: 'memory', label: t('machineServices.facts.memory'), value: known
      ? formatMachineBytes(samples.reduce((sum, sample) => sum + (sample.memoryBytes ?? 0), 0), 'memory')
      : t('machineServices.facts.notReported') });
  } else if (run.memoryBytes !== null) {
    // The detail's own sample is the fresher one; without it the row's reported memory still says it.
    facts.push({ key: 'memory', label: t('machineServices.facts.memory'), value: formatMachineBytes(run.memoryBytes, 'memory') });
  }
  const configuration = detail?.runtimeFacts?.configuration ?? null;
  if (configuration) {
    const declared = machineServiceDeclaredFacts(configuration);
    if (declared.replicas !== null) facts.push({ key: 'replicas', label: t('machineServices.facts.replicas'),
      value: t('machineServices.facts.replicasDeclared', { count: String(declared.replicas) }) });
    if (declared.limits !== null) facts.push({ key: 'limits', label: t('machineServices.facts.limits'), value: declared.limits });
    if (declared.restart !== null) facts.push({ key: 'restart', label: t('machineServices.facts.restartPolicy'),
      value: isMachineServiceRestart(declared.restart) ? t(`machineServices.facts.restart.${declared.restart}`) : declared.restart });
  }
  return facts;
}

const NO_IDS: readonly string[] = [];
const SINCE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s12,
  },
  facts: {
    marginTop: theme.space.s16,
  },
  since: {
    marginTop: theme.space.s12,
  },
  outcome: {
    marginTop: theme.space.s8,
  },
}));
