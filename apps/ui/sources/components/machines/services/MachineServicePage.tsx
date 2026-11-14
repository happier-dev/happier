import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import { InvestigationAgentActionButtons, type InvestigationAgentActionButtonModel } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { useMachinePortEntry } from '@/components/machines/localServices/MachinePortActions';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { deploymentEnvironmentRoute } from '@/components/projects/deployments/deploymentNavigation';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { describeActionExecutionPrerequisite, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type { MachineServicesReadError } from './useMachineServices';

import { MachineServiceLogs } from './MachineServiceLogs';
import { MachineServiceUsageHistory } from './MachineServiceUsageHistory';
import { MachineServiceControlOutcomeNotice } from './MachineServiceControlOutcomeNotice';
import { showServiceCommandSheet } from './command/ServiceCommandSheet';
import { canAdoptMachineService } from './adoption/machineServiceAdoptionPresentation';
import { showMachineServiceAdoption } from './adoption/MachineServiceAdoptionSheet';
import {
  machineServiceControls,
  machineServiceDisplayName,
  machineServiceConfigurationRows,
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
  type MachineServiceDetailFacts,
} from './useMachineServiceDetail';
import { useMachineServiceEnvironments, useMachineServiceSourceName } from './useMachineServiceEnvironments';
import { useMachineServiceActions } from './useMachineServiceActions';

const SERVICE_AGENT_ACTIONS = { agentActions: 'withDefault' } as const;

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
    listError?: MachineServicesReadError | null;
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
              reason={resolveActionExecutionErrorMessage(props.listError, t('common.requestFailed'), { safeToRetry: true })}
              diagnosticCode={props.listError?.code}
              action={describeActionExecutionPrerequisite(props.listError?.code) ? undefined
                : { label: t('common.retry'), onPress: props.onRetry }}
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
  const serviceName = machineServiceDisplayName(service);
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
  const { facts: detail, measuring, measure } = useMachineServiceDetail({ serverId: props.serverId, machineId: props.machineId,
    serviceId: service.serviceId, generation: service.generation, active: props.active });
  const usage = React.useMemo(() => usageFacts(detail), [detail]);
  // Configuration (pfc-redesign dCtr): what the Machine reports this service was started with; absent until it does.
  const configurationSource = detail?.runtimeFacts?.configuration ?? null;
  const configurationDetails = detail?.runtimeFacts?.configurationDetails;
  const configuration = React.useMemo(() => configurationSource
    ? machineServiceConfigurationRows(configurationSource, configurationDetails) : null, [configurationSource, configurationDetails]);
  // The service's Environment, by the address its admitted header names (the Services list's Open environment).
  const router = useRouter();
  const openEnvironment = React.useMemo(() => environmentId && header ? () => router.push(deploymentEnvironmentRoute({
    serverId: props.serverId, projectSourceId: header.projectSourceId, environmentId })) : null,
  [environmentId, header, props.serverId, router]);
  const control = useMachineServiceControl({ serverId: props.serverId, machineId: props.machineId, service });
  const offered = machineServiceControls(service);
  // One visible control (lab `services/detail`): Restart, or Start when the service is down; the rest sit in ⋯.
  // A Machine that isn't answering can't act on its services, so none of them is offered.
  const visible = props.offline ? null : offered.restart ? 'restart' as const : offered.start ? 'start' as const : null;
  const menuStart = !props.offline && offered.start && visible !== 'start';
  const menuStop = !props.offline && offered.stop;
  const serviceActions = useMachineServiceActions({ serverId: props.serverId, machineId: props.machineId,
    machineName, service, offline: props.offline });
  // Run a command (P30 §463) reaches the service's own container at the generation the page shows; a watched
  // Compose project with several members asks which one.
  const generation = service.generation;
  const runCommand = !serviceActions.command || generation === null ? null : () => showServiceCommandSheet({
    serverId: props.serverId, machineId: props.machineId, machineName, serviceName,
    place: header ? keeper : null, target: { kind: 'current', serviceId: service.serviceId, expectedGeneration: generation },
    ...(serviceActions.members.length > 0 ? { services: serviceActions.members } : {}) });
  const expectedStop = machineServiceExpectedStop(service);
  const facts = React.useMemo(() => serviceFacts(service, detail, expectedStop), [service, detail, expectedStop]);
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
  const triggerSubject = React.useMemo(() => ({ kind: 'service' as const, machineId: props.machineId, serviceId: service.serviceId }),
    [props.machineId, service.serviceId]);
  const investigateSubject = React.useMemo(() => props.active && !expectedStop && service.identity
    && (service.state === 'unhealthy' || service.state === 'failed') ? {
      kind: 'service' as const,
      target: { kind: 'host' as const, page: 'machine_service' as const,
        machine: { serverId: props.serverId, machineId: props.machineId }, service: service.identity },
    } : null, [props.active, props.serverId, props.machineId, expectedStop, service.identity, service.state]);
  const investigationOptions = React.useMemo(() => ({ ...SERVICE_AGENT_ACTIONS,
    externalActionTarget: { kind: 'machine' as const, machineId: props.machineId },
  }), [props.machineId]);
  const investigation = useInvestigateFailure(investigateSubject, investigationOptions);
  const fallbackInvestigate: readonly InvestigationAgentActionButtonModel[] = [{
    label: t('inbox.work.healthNotice.investigate'), launchMode: 'review', startable: true,
  }];
  return (
    <View testID="machine-service-page">
      <MachineTabSubHead
        title={serviceName}
        mark={<Icon name={machineServiceIcon(service)} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
        back={props.back}
        description={meta || null}
      >
        {investigateSubject || visible || portOpen || adopt || menuStop || menuStart || runCommand || serviceActions.shell || serviceActions.unwatch ? (
          <View style={styles.controls} testID="machine-service-controls">
            {investigateSubject ? <InvestigationAgentActionButtons
              actions={investigation.actions ?? fallbackInvestigate}
              pending={investigation.pending}
              compact={false}
              onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }}
            /> : null}
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
                accessibilityLabel={t('machineServices.control.openLabel', { service: serviceName })}
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
              accessibilityLabel={`${t(`machineServices.control.${visible}`)} ${serviceName}`}
              leading={<Icon name={visible === 'restart' ? 'arrow-clockwise' : 'play'} size={14} color={theme.colors.text.primary} />}
              loading={control.pending === visible}
              disabled={control.pending !== null}
              onPress={() => control.run(visible)}
            /> : null}
            {menuStop || menuStart || runCommand || serviceActions.shell || serviceActions.unwatch ? (
              <ServiceMoreMenu
                serviceName={serviceName}
                stop={menuStop}
                start={menuStart}
                onRunCommand={runCommand}
                onOpenShell={serviceActions.shell}
                shellMembers={serviceActions.members}
                onUnwatch={serviceActions.unwatch}
                disabled={control.pending !== null || serviceActions.pending}
                onRun={control.run}
              />
            ) : null}
          </View>
        ) : null}
      </MachineTabSubHead>
      <ItemGroup surface="none" header="none" testID="machine-service-state">
        {props.stale}
        {investigateSubject && investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner
          outcome={investigation.outcome} serverId={props.serverId} testID="machine-service-investigate"
          onChoosePlacement={investigation.investigateWithPlacement} pending={investigation.pending}
        /> : null}
        {serviceActions.outcome ? <SurfaceStateCard
          testID="machine-service-unwatch-outcome"
          size="line"
          kind={serviceActions.outcome.kind === 'unwatched' ? 'success' : 'error'}
          title={serviceActions.outcome.kind === 'unwatched' ? t('machineServices.actions.unwatched')
            : serviceActions.outcome.kind === 'conflict' ? t('machineServices.actions.unwatchConflict')
              : t('machineServices.actions.unwatchFailed')}
          diagnosticCode={serviceActions.outcome.kind === 'failed' ? serviceActions.outcome.code : undefined}
        /> : null}
        {portOpen?.reason ? (
          <Text variant="meta" testID="machine-service-open-reason" style={[styles.outcome, { color: theme.colors.text.secondary }]}>
            {portOpen.reason}
          </Text>
        ) : null}
        {adoptable ? (
          <Text variant="body" testID="machine-service-watched-note" style={[styles.since, { color: theme.colors.text.secondary }]}>
            {t('machineServices.adopt.watchedNote', { service: serviceName })}
          </Text>
        ) : null}
        {since === null ? null : (
          // The page's state line (lab `services/detail`) reads in ink: it is what the service is doing now.
          <Text variant="body" testID="machine-service-since" style={[styles.since, { color: theme.colors.text.primary }]}>
            {since}
          </Text>
        )}
        <View style={styles.facts}>
          <FactStrip facts={facts} testID="machine-service-facts" />
        </View>
        {control.outcome ? <MachineServiceControlOutcomeNotice outcome={control.outcome}
          service={serviceName} machine={machineName} testID="machine-service-control-outcome" style={styles.outcome} /> : null}
      </ItemGroup>
      {/* Usage (lab `services/usage`): each replica's usage measured now, then the service's own CPU and memory history
          over the Machine's range. The history reads while this page is presented, with or without a sample. */}
      <ItemGroup title={t('machineServices.usage.title')} surface="none" testID="machine-service-usage">
      {usage && detail ? (
        <>
          <FactStrip facts={usage} testID="machine-service-usage-facts" />
          {/* One quiet line under the figures (lab `services/usage`): when they were measured, and Measure again. */}
          <View style={styles.measured} testID="machine-service-usage-measured">
            <Icon name="clock" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {measuring ? t('machineServices.usage.measuring') : t('machineServices.usage.measured', {
                time: formatWithCachedDateTimeFormatter(detail.measuredAt, undefined, MEASURED_FORMAT) })}
            </Text>
            <TextLinkButton testID="machine-service-measure" size="meta" tone="strong" disabled={measuring}
              label={t('machineServices.usage.measure')} onPress={measure} />
          </View>
        </>
      ) : null}
        <View style={usage && detail ? styles.history : null}>
          <MachineServiceUsageHistory serverId={props.serverId} machineId={props.machineId} serviceId={service.serviceId}
            active={props.active} />
        </View>
      </ItemGroup>
      {configuration ? (
        // Configuration (lab dCtr): a label beside each reported value, what qualifies it beneath; several values list.
        <ItemGroup title={t('machineServices.configuration.title')}
          description={t('machineServices.configuration.description')} testID="machine-service-configuration">
          {configuration.map((row) => row.entries.length === 1 ? (
            <Item key={row.key} testID={`machine-service-configuration.${row.key}`} mode="info" title={row.label}
              detail={row.entries[0]!.value} {...(row.entries[0]!.note ? { subtitle: row.entries[0]!.note } : {})} />
          ) : (
            <Item key={row.key} testID={`machine-service-configuration.${row.key}`} mode="info" title={row.label}
              subtitleLines={0}
              subtitle={row.entries.map((entry) => entry.note ? `${entry.value} · ${entry.note}` : entry.value).join('\n')} />
          ))}
        </ItemGroup>
      ) : null}
      <ItemGroup
        title={t('machineServices.logs.title')}
        description={t('machineServices.logs.description', { service: serviceName })}
        surface="none"
      >
        <MachineServiceLogs
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={machineName}
          service={service}
          active={props.active}
          onOpenEnvironment={openEnvironment}
        />
      </ItemGroup>
      {/* What starts here by itself (OPS-AUTOMATIONS-1102 D2): triggers on this service's Machine, set up from here. */}
      <SubjectTriggersSection subject={triggerSubject} subjectName={serviceName} />
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
  /** Run a command…, for a deployed service; null where the service has no container of its own to run in. */
  onRunCommand: (() => void) | null;
  /** Opens the shell; with several Compose members, in the one the person picks from the row's submenu. */
  onOpenShell: ((member?: string) => void) | null;
  shellMembers: readonly string[];
  onUnwatch: (() => Promise<void>) | null;
}>) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo((): readonly DropdownMenuItem[] => [
    ...(props.onRunCommand ? [{ id: 'command', testID: 'machine-service-command', title: t('machineServices.control.runCommand'),
      subtitle: t('machineServices.control.runCommandDetail'),
      icon: <Icon name="terminal" size={16} color={theme.colors.text.secondary} /> }] : []),
    ...(props.onOpenShell ? [{ id: 'shell', testID: 'machine-service-shell', title: t('machineServices.actions.shell'),
      icon: <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
      ...(props.shellMembers.length > 0 ? { submenu: {
        items: props.shellMembers.map(member => ({ id: `shell:${member}`, testID: `machine-service-shell:${member}`, title: member })),
      } } : {}) }] : []),
    ...(props.start ? [{ id: 'start', testID: 'machine-service-start', title: t('machineServices.control.start'),
      icon: <Icon name="play" size={16} color={theme.colors.text.secondary} /> }] : []),
    // Unwatching only stops Happier following the service; it keeps running, so it reads as "stop looking".
    ...(props.onUnwatch ? [{ id: 'unwatch', testID: 'machine-service-unwatch', title: t('machineServices.actions.unwatch'),
      icon: <Icon name="eye-slash" size={16} color={theme.colors.text.secondary} /> }] : []),
    // Stop interrupts what the service serves: the one destructive item, last and set apart.
    ...(props.stop ? [{ id: 'stop', testID: 'machine-service-stop', title: t('machineServices.control.stop'),
      category: 'stop', destructive: true,
      icon: <Icon name="stop" size={16} color={theme.colors.state.danger.foreground} /> }] : []),
  ], [props.onRunCommand, props.onOpenShell, props.shellMembers, props.onUnwatch, props.start, props.stop,
    theme.colors.text.secondary, theme.colors.state.danger.foreground]);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      separateCategories
      popoverAccessibilityLabel={t('common.more')}
      onSelect={(id) => {
        if (id === 'command') props.onRunCommand?.();
        else if (id === 'shell') props.onOpenShell?.();
        else if (id.startsWith('shell:')) props.onOpenShell?.(id.slice('shell:'.length));
        else if (id === 'unwatch' && props.onUnwatch) fireAndForget(props.onUnwatch(), { tag: 'MachineServices.unwatch' });
        else if (id === 'stop' || id === 'start') props.onRun(id);
      }}
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


/**
 * The service's facts (lab `fc-facts`), each only when its producer supplies it: health from the native source,
 * the port, memory from the detail's one accounting sample, and the declared Compose replicas, limits and restart
 * policy. Declared replicas are not an observed count; a missing counter says so instead of reading as zero.
 */
function serviceFacts(service: MachineServiceRowV1, detail: MachineServiceDetailFacts | null,
  expectedStop: ReturnType<typeof machineServiceExpectedStop>): FactStripFact[] {
  // Health is the service's state alone, in its tone; what kind of service it is stays on the identity line.
  // A running service its own health source hasn't verified says so beside Running; it never reads as healthy.
  const qualifier = machineServiceHealthQualifier(service);
  // A stop the person asked for is that stop, in no warning tone (lab `services/states` "Stopped by you").
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
  // A sample's memory is in Usage, per replica (lab `services/usage`); without one the row's reported memory says it.
  if (!(samples && samples.length > 0) && run.memoryBytes !== null) {
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

/**
 * Each replica's usage and container-lifetime counters, in sample order ("4% · 3%", "318 · 296 MB"); a replica whose sample omits a figure
 * says so rather than reading as zero. Null when the detail carries no sample.
 */
function usageFacts(detail: MachineServiceDetailFacts | null): FactStripFact[] | null {
  const samples = detail?.accounting?.kind === 'sample' ? detail.accounting.samples : null;
  if (!samples || samples.length === 0) return null;
  const notReported = t('machineServices.facts.notReported');
  return [
    { key: 'cpu', label: t('machineServices.usage.cpu'),
      value: samples.map((sample) => sample.cpuPercent === null ? notReported : `${Math.round(sample.cpuPercent)}%`).join(' · ') },
    { key: 'memory', label: t('machineServices.facts.memory'),
      value: samples.map((sample) => sample.memoryBytes === null ? notReported
        : formatMachineBytes(sample.memoryBytes, 'memory')).join(' · ') },
    { key: 'networkReceived', label: t('machineServices.usage.networkReceived'),
      value: samples.map((sample) => sample.networkReceivedBytes == null ? notReported
        : formatMachineBytes(sample.networkReceivedBytes, 'memory')).join(' · ') },
    { key: 'networkSent', label: t('machineServices.usage.networkSent'),
      value: samples.map((sample) => sample.networkSentBytes == null ? notReported
        : formatMachineBytes(sample.networkSentBytes, 'memory')).join(' · ') },
    { key: 'restarts', label: t('machineServices.usage.restarts'),
      value: samples.map((sample) => sample.restartCount == null ? notReported : String(sample.restartCount)).join(' · ') },
  ];
}

const NO_IDS: readonly string[] = [];
const MEASURED_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
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
  history: {
    marginTop: theme.space.s16,
  },
  measured: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s6,
    marginTop: theme.space.s12,
  },
  since: {
    marginTop: theme.space.s12,
  },
  outcome: {
    marginTop: theme.space.s8,
  },
}));
