import * as React from 'react';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { useShallow } from 'zustand/react/shallow';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { MachineAddWays } from '@/components/machines/add/MachineAddWays';
import type { MachineAttentionEntry } from '@/components/machines/attention/collectMachineAttention';
import { useMachineAttention } from '@/sync/domains/machines/resources/useMachineAttention';
import { MachineCardBody } from '@/components/machines/index/MachineCardBody';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import {
  machinePageHref,
  machinesIndexHref,
} from '@/components/machines/page/machinePageHref';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import {
  describeMachineAttentionWord,
  describeMachineReasonDetail,
  resolveMachineReasonAction,
  selectAttentionSubjects,
  selectHeadlineReason,
} from '@/components/machines/summary/machineResourceSentences';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import { mergeStableProcessOrder } from '@/components/machines/processes/processesPresentation';
import { reanimatedDisclosureMotion } from '@/components/ui/lists/ExpandableItem';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useMachineActivity } from '@/hooks/machine/useMachineActivity';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { MachineSummaryStrip } from '@/components/machines/summary/MachineSummaryStrip';
import { MACHINE_SUMMARY_METRICS, MACHINE_SUMMARY_STYLES, normalizeMachineSummaryMetrics, type MachineSummaryMetric, type MachineSummaryStyle, resolveMachineAttentionWordColor } from '@/components/machines/summary/machineSummaryStripModel';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import {
  MachineWorkingCountsProvider,
  useMachineWorkingCount,
} from '@/components/machines/work/machineWorkingCounts';
import { MachineCliLogoRow } from '@/components/sessions/new/components/MachineCliLogoRow';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolveItemTextColumnInset } from '@/components/ui/lists/itemDensityMetrics';
import { Typography } from '@/constants/Typography';
import { HappierDisclosure, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useMachinesCapabilitySnapshots } from '@/updates/machineCapabilitySnapshots';
import { useMachineUpdateRuns } from '@/updates/machineUpdateRuns';
import { buildRemoteMachineUpdateFacts } from '@/updates/remoteCliUpdateItems';
import { useThisComputerCliUpdate } from '@/updates/useThisComputerCliUpdate';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineFleetPresence, partitionMachineFleetPresence, type MachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  MachineWidgetColumn,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetSize,
  type MachineWidgetBodyProps,
} from './machineWidgetKit';

/** Update states that ask the person to act (the Updates surface owns the action). */
const UPDATE_WAITING = new Set(['available', 'required']);

export type FleetMachine = Readonly<{
  key: string;
  serverId: string;
  machine: Machine;
  name: string;
  online: boolean | null;
  fleetPresence: MachineFleetPresence;
  thisComputer: boolean;
}>;

/**
 * The fleet's calm order (lab `FL` "Order"): this computer first, then by name, offline last. Machines that need
 * the person lead above it (`useFleetRowOrder`), so calm rows never reorder by state while the person looks.
 */
export function orderFleetMachines(
  machines: readonly FleetMachine[],
): readonly FleetMachine[] {
  return [...machines].sort(
    (left, right) =>
      Number(right.online) - Number(left.online) ||
      Number(right.thisComputer) - Number(left.thisComputer) ||
      left.name.localeCompare(right.name),
  );
}

/** The widget's own style and metrics, defaulting to the device's Machine summary setting (R8). */
export function resolveFleetPresentation(
  input: Readonly<Record<string, unknown>>,
  device: Readonly<{
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
  }>,
) {
  const style =
    typeof input.style === 'string' &&
    (MACHINE_SUMMARY_STYLES as readonly string[]).includes(input.style)
      ? (input.style as MachineSummaryStyle)
      : device.style;
  const metrics = Array.isArray(input.metrics)
    ? normalizeMachineSummaryMetrics(
        input.metrics.filter(
          (metric): metric is MachineSummaryMetric =>
            typeof metric === 'string' &&
            (MACHINE_SUMMARY_METRICS as readonly string[]).includes(metric),
        ),
      )
    : device.metrics;
  return { style, metrics };
}

/**
 * Machines (lab `rw` FL, AGW-20): the Home's machines as a widget — the one Home machine summary. A machine
 * that needs the person is the Machines page's needs-you block (reason in tone, its detail, one action); a calm
 * machine is its name with the summary strip; offline is one quiet line, last. Large is every machine's card
 * (the All machines card body) with its agents and a waiting update.
 */
export function MachineFleetWidget(props: MachineWidgetBodyProps) {
  return (
    <MachineWorkingCountsProvider>
      <FleetBody {...props} />
    </MachineWorkingCountsProvider>
  );
}

/**
 * This Home's fleet as the Machines widget reads it: every visible machine in its held order, which of
 * them need the person, and whether the machine list has arrived. The widget and any page that
 * summarises the fleet (Settings › Overview) read this one model.
 */
export function useMachineFleetModel(owningServerId?: string) {
  const reachabilityRevision = useMachineReachabilityRevision();
  const explicitServerId = owningServerId?.trim();
  const activeServer = useActiveServerSnapshot(!explicitServerId);
  const serverId = resolveServerProfileScopeIdForIdentifier(explicitServerId || activeServer.serverId);
  const homeLabel = useHomeDisplayLabel(getServerProfileById(serverId));
  const identity = useServerCredentialAccountScopeBinding(serverId);
  const accountScope = identity.resolution.kind === 'bound' ? identity.resolution.scope : null;
  const allMachines = getStorage()(useShallow(state => resolveVisibleMachinesForActiveServerFromState(state, { serverId })));
  // App data can arrive before this Home's machine list: until the list has been read, an empty fleet
  // means "still reading", never "no machines" (the same readiness owner as the Setup checklist).
  const settled = useIsMachineListSettled(serverId);
  const status = useMachineListStatusForServer(serverId);
  const refresh = React.useCallback(() => {
    fireAndForget(sync.refreshMachines({ serverId }), { tag: 'MachineFleet.refresh' });
  }, [serverId]);
  const nowMs = useMachinePresenceNowMs(allMachines);
  const thisComputerMachineId = useThisComputerMachineId();
  const fleet = React.useMemo(() => {
    const visible = allMachines.map(machine => ({ machine, fleetPresence: resolveMachineFleetPresence(accountScope, machine, nowMs) }))
      .filter(entry => entry.fleetPresence.member);
    const names = resolveMachineDisplayNames(visible.map(entry => entry.machine));
    return orderFleetMachines(visible.map(({ machine, fleetPresence }) => {
      return { key: JSON.stringify([serverId, machine.id]), serverId, machine,
        name: names.get(machine.id) ?? machine.id, fleetPresence, online: fleetPresence.online, thisComputer: machine.id === thisComputerMachineId };
    }));
  }, [accountScope, allMachines, nowMs, reachabilityRevision, serverId, thisComputerMachineId]);
  const attention = useMachineAttention([{ serverId, accountScope, serverName: '', status,
    machines: fleet.map((entry) => entry.machine) }]);
  const needs = React.useMemo(() => selectAttentionSubjects(attention.entries), [attention.entries]);
  const needsByKey = React.useMemo(() => new Map(needs.map((entry) => [entry.key, entry])), [needs]);
  const presence = React.useMemo(() => partitionMachineFleetPresence(fleet, entry => entry.fleetPresence), [fleet]);
  return { serverId, homeLabel, status, settled, refresh, fleet, presence, needs, needsByKey };
}

function FleetBody(props: MachineWidgetBodyProps) {
  const size = useMachineWidgetSize();
  // The widget reads every machine, so its frame says so where a bound one names its machine (lab rw H).
  useWidgetFrameBodyCaption(t('machines.widgets.body.activity.allMachines'));
  const device = useMachineSummarySettingValue();
  const { style, metrics } = resolveFleetPresentation(props.input, device);
  const { serverId, status, settled: machineListSettled, refresh, fleet, needs, needsByKey } = useMachineFleetModel(props.serverId);
  // A mounted Machines widget keeps its online machines' summaries live (one batched demand).
  const demand = React.useMemo(() => fleet.filter((entry) => entry.online).map((entry) => ({ serverId, machineId: entry.machine.id })), [fleet, serverId]);
  useMachineResourceLiveDemand(demand, { detail: 'summary', enabled: metrics.length > 0 });
  const order = useFleetRowOrder(fleet, needs);
  const door = useMachinesDoor();
  const router = useRouter();
  const openMachine = React.useCallback((target: Readonly<{ serverId: string; machineId: string }>, tab?: MachinePageTabParams | null) => {
    const result = runGuardedNavigation(() => router.push(machinePageHref({ door, target, ...(tab ? { tab } : {}) }) as never));
    if (result !== true) fireAndForget(result, { tag: 'MachineFleetWidget.open' });
  }, [door, router]);
  const openIndex = React.useCallback(() => {
    const result = runGuardedNavigation(() => router.push(machinesIndexHref(door) as never));
    if (result !== true) fireAndForget(result, { tag: 'MachineFleetWidget.index' });
  }, [door, router]);

  if (fleet.length === 0 && (status === 'error' || status === 'signedOut')) {
    return <MachineWidgetState kind="error" onRetry={refresh} testID={props.testID} />;
  }
  if (fleet.length === 0 && !machineListSettled) {
    return <MachineWidgetState kind="loading" testID={props.testID} />;
  }
  const freshness = status === 'error' || status === 'signedOut' || status === 'loading' ? (
    <SurfaceFreshnessLine testID={`${props.testID}.freshness`} busy={status === 'loading'}
      reason={t(status === 'loading' ? 'machines.widgets.body.common.loading' : 'machines.widgets.body.common.readFailed')}
      action={status === 'loading' ? undefined : { label: t('common.retry'), onPress: refresh }} />
  ) : null;
  // No machine yet (58d AF1): the empty state is the ways to add one, each opening the one Add chooser.
  if (fleet.length === 0) return <MachineAddWays serverId={serverId} testIDPrefix={props.testID} />;
  // With one machine, Vitals says it all: this widget invites a second one instead of a list of one (lab FL).
  if (fleet.length === 1) {
    return <>{freshness}<MachineWidgetState kind="empty" title={t('machines.widgets.body.fleet.oneMachineTitle')}
      reason={t('machines.widgets.body.fleet.oneMachineBody')} action={{ label: t('machines.widgets.body.fleet.addMachine'), onPress: openIndex }}
      testID={props.testID} /></>;
  }
  if (size === 'large') return <>{freshness}<FleetCards fleet={fleet} serverId={serverId} style={style} metrics={metrics} openMachine={openMachine} testID={props.testID} /></>;
  const byKey = new Map(fleet.map((entry) => [entry.key, entry]));
  const ordered = order.flatMap((key) => (byKey.get(key) ? [byKey.get(key)!] : []));
  const calm = ordered.filter((entry) => entry.online && !needsByKey.has(entry.key));
  const { offline, unknown } = partitionMachineFleetPresence(ordered, entry => entry.fleetPresence);
  const row = (entry: FleetMachine, compact: boolean) => (
    <FleetMachineRow key={entry.key} entry={entry} need={needsByKey.get(entry.key) ?? null} compact={compact} style={style}
      metrics={compact ? [] : metrics} onOpen={openMachine} testID={`${props.testID}.machine.${entry.machine.id}`} />
  );
  const rows = (list: readonly FleetMachine[], compact: boolean) => list.length === 0 ? null : (
    <ItemGroup header="none" surface="none" density="compact">{list.map((entry) => row(entry, compact))}</ItemGroup>
  );
  if (size === 'small' || size === 'wide') {
    // Small sizes list only who needs the person (in a word); calm and offline collapse into one line.
    const shown = needs.length > 0 ? ordered.filter((entry) => needsByKey.has(entry.key)) : [...calm, ...unknown].slice(0, 2);
    const rest = describeRest(needs.length > 0 ? calm : calm.slice(2), offline, needs.length);
    // Wide has two columns of room: the blocks stand side by side, as the card's two halves (lab FL Wide).
    const half = Math.ceil(shown.length / 2);
    const listed = size === 'wide' && shown.length > 1
      ? <MachineWidgetTwoColumns lead={rows(shown.slice(0, half), false)} rest={rows(shown.slice(half), false)} />
      : rows(shown, size === 'small');
    // Nothing to list: the quiet line is the whole body, a one-line state the frame sizes the card to.
    if (!listed && rest) return <>{freshness}<MachineWidgetState kind="unavailable" size="line" title={rest} testID={props.testID} /></>;
    return (
      <MachineWidgetColumn testID={props.testID}>
        {freshness}
        {listed}
        {rest ? <Text testID={`${props.testID}.rest`} numberOfLines={2} style={styles.rest}>{rest}</Text> : null}
      </MachineWidgetColumn>
    );
  }
  // Medium and up: every online machine in one held order; a machine that needs the person opens its block in
  // place, and when it recovers the block folds back into its calm row (lab rw FL "Order", MO).
  const online = ordered.filter((entry) => entry.online !== false);
  // Medium and Full are two rows high: offline machines are one quiet line at the end ("studio is offline",
  // "8 are offline", lab FL Medium), so a long offline list never runs past the card. Tall lists them.
  const offlineLine = describeRest([], offline, online.length);
  const offlineEnd = size === 'tall' ? (offline.length > 0 ? (
    <>
      <Text style={styles.label}>{t('machines.widgets.body.fleet.offlineGroup', { count: offline.length })}</Text>
      {rows(offline, false)}
    </>
  ) : null) : offlineLine ? <Text testID={`${props.testID}.rest`} numberOfLines={2} style={styles.rest}>{offlineLine}</Text> : null;
  if (online.length === 0 && size !== 'tall' && offlineLine) {
    return <>{freshness}<MachineWidgetState kind="unavailable" size="line" title={offlineLine} testID={props.testID} /></>;
  }
  if (size === 'full') {
    const half = Math.ceil(online.length / 2);
    return <MachineWidgetColumn testID={props.testID}>{freshness}<MachineWidgetTwoColumns lead={rows(online.slice(0, half), false)}
      rest={rows(online.slice(half), false)} />{offlineEnd}</MachineWidgetColumn>;
  }
  return <MachineWidgetColumn testID={props.testID}>{freshness}{rows(online, false)}{offlineEnd}</MachineWidgetColumn>;
}

/**
 * The rows' order, held while the person looks (lab FL "Order"): worst first, then calm with this computer
 * first, offline last. Machines that need the person always lead, even when that fact arrives after the rows;
 * a machine that recovers keeps its place, and a new machine joins the end.
 */
function useFleetRowOrder(fleet: readonly FleetMachine[], needs: readonly MachineAttentionEntry[]): readonly string[] {
  const needKeys = needs.map((entry) => entry.key);
  const needing = new Set(needKeys);
  const fresh = fleet.filter((entry) => !needing.has(entry.key)).map((entry) => entry.key);
  const held = React.useRef<readonly string[]>([]);
  const next = [...needKeys, ...mergeStableProcessOrder(held.current.filter((key) => !needing.has(key)), fresh)];
  if (next.length !== held.current.length || next.some((key, index) => key !== held.current[index])) held.current = next;
  return held.current;
}

/** "4 others are calm · studio is offline": the machines a small size does not list, in one quiet line. */
export function describeRest(calm: readonly FleetMachine[], offline: readonly FleetMachine[], listed: number): string | null {
  const parts: string[] = [];
  if (calm.length > 0) parts.push(listed > 0 ? t('machines.widgets.body.fleet.othersCalm', { count: calm.length }) : t('machines.widgets.body.fleet.allCalm', { count: calm.length }));
  if (offline.length === 1) parts.push(t('machines.widgets.body.fleet.oneOffline', { machine: offline[0]!.name }));
  // After "4 others are calm" the count reads on ("· 8 are offline"); standing alone it names what it counts,
  // as the All machines list does ("8 machines are offline").
  else if (offline.length > 1) parts.push(parts.length > 0 ? t('machines.widgets.body.fleet.manyOffline', { count: offline.length })
    : t('allMachines.offlineHidden', { count: offline.length }));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * One machine: its mark, name, what it is doing and its strip (row-local reads). A machine that needs the person
 * opens its block in place — the reason in tone, one line of detail, its one action — through the shared
 * disclosure (height + opacity, instant under reduced motion); recovering folds it back, nothing else moves.
 * `compact` (Small) says only the reason, in a word, at the row's end.
 */
const FleetMachineRow = React.memo(function FleetMachineRow(props: Readonly<{
  entry: FleetMachine;
  need: MachineAttentionEntry | null;
  compact: boolean;
  style: MachineSummaryStyle;
  metrics: readonly MachineSummaryMetric[];
  onOpen: (target: Readonly<{ serverId: string; machineId: string }>, tab?: MachinePageTabParams | null) => void;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const { entry, need } = props;
  const activity = useMachineActivity(entry.online === false ? entry.machine : null);
  const target = React.useMemo(() => ({ serverId: entry.serverId, machineId: entry.machine.id }), [entry.machine.id, entry.serverId]);
  const availability = useMachineResourceSummary(target);
  const working = useMachineWorkingCount(target);
  const reason = need ? selectHeadlineReason(need.attention) : null;
  const tone = reason ? resolveMachineAttentionWordColor(theme.colors) : null;
  const word = reason ? describeMachineAttentionWord(reason) : null;
  const subtitle = entry.online === null ? t('common.unknown') : !entry.online
    ? t('settingsOverview.machineLastSeen', { lastSeen: formatLastSeen(activity?.activeAt ?? 0) })
    : working > 0 ? t('machineDetailPage.work.working', { count: working }) : t('machineDetailPage.work.none');
  const strip = entry.online && props.metrics.length > 0 && availability?.kind !== 'not_reported'
    ? <MachineSummaryStrip availability={availability} style={props.style} metrics={props.metrics} layout="under" testID={`${props.testID}.strip`} />
    : undefined;
  const doing = entry.online && !props.compact
    ? <Text numberOfLines={1} style={styles.doing}>{subtitle}</Text>
    : undefined;
  const header = (
    <Item testID={props.testID} title={entry.name} titleEllipsizeMode="middle" subtitle={doing ? undefined : subtitle} titleAccessory={doing}
      icon={<Icon name={resolveMachineKindGlyph({ isThisComputer: entry.thisComputer, platform: entry.machine.metadata?.platform })} color={entry.online ? theme.colors.text.secondary : theme.colors.text.tertiary} />}
      onPress={() => props.onOpen(target)} showChevron={false} accessoryLayout="adaptive"
      {...(word ? { accessibilityLabel: `${entry.name}, ${word}` } : {})}
      rightElement={props.compact && word && tone ? <Text numberOfLines={1} style={[styles.word, { color: tone }]}>{word}</Text> : strip} />
  );
  if (props.compact) return header;
  const action = reason ? resolveMachineReasonAction(reason) : null;
  return (
    <HappierDisclosure expanded={reason !== null} onExpandedChange={noop} header={header} showDivider={false}
      reducedMotion={reducedMotion} motion={reanimatedDisclosureMotion} testID={`${props.testID}.fold`}>
      {reason && word && tone ? (
        <View testID={`${props.testID}.need`} style={styles.need}>
          <Text numberOfLines={1} style={[styles.word, { color: tone }]} accessibilityLiveRegion="polite">{word}</Text>
          <Text numberOfLines={2} style={styles.rest}>{describeMachineReasonDetail(reason, Date.now())}</Text>
          {action && need ? (
            <View style={styles.needAction}>
              <RoundButton testID={`${props.testID}.action`} size="small" display="secondary" title={action.label}
                onPress={() => { beginMachinePageTabIntent(need, action.tab); props.onOpen(target, action.tab); }} />
            </View>
          ) : null}
        </View>
      ) : null}
    </HappierDisclosure>
  );
});

function noop(): void {}

/**
 * Large (AGW-20, plan 10 D2 default): every machine's card — the All machines card body with its metric tiles,
 * the agents an earlier detect found while it is online, and an Update action when one is waiting. Nothing is
 * asked of a machine: the agents are the last cached answer.
 */
function FleetCards(
  props: Readonly<{
    fleet: readonly FleetMachine[];
    serverId: string;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
    openMachine: (
      target: Readonly<{ serverId: string; machineId: string }>,
    ) => void;
    testID: string;
  }>,
) {
  const machines = React.useMemo(
    () => props.fleet.map((entry) => entry.machine),
    [props.fleet],
  );
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.id),
    [machines],
  );
  const thisComputer = useThisComputerCliUpdate();
  const identity = useServerCredentialAccountScopeBinding(props.serverId);
  const accountScope = identity.resolution.kind === 'bound' ? identity.resolution.scope : null;
  const runs = useMachineUpdateRuns(props.serverId);
  const snapshots = useMachinesCapabilitySnapshots(props.serverId, machineIds, accountScope?.accountId);
  const updating = React.useMemo(
    () =>
      new Set(
        buildRemoteMachineUpdateFacts(
          machines,
          thisComputer.machineId,
          runs,
          snapshots,
          accountScope,
        )
          .filter((facts) => UPDATE_WAITING.has(facts.cliItem.state))
          .map((facts) => facts.machine.id),
      ),
    [machines, runs, snapshots, thisComputer.machineId, accountScope],
  );
  const agents = useMachineAgentsByMachine({
    serverId: props.serverId,
    machineIds,
    load: false,
  });
  return (
    <View testID={props.testID}>
      <CardGrid testID={`${props.testID}.cards`}>
        {props.fleet.map((entry) => (
          <View key={entry.key} style={styles.card}>
            <FleetMachineCard
              entry={entry}
              style={props.style}
              metrics={props.metrics}
              hasUpdate={updating.has(entry.machine.id)}
              agents={
                entry.online
                  ? (agents
                      .get(entry.machine.id)
                      ?.agents.filter((agent) => agent.installed) ?? [])
                  : []
              }
              onOpen={() =>
                props.openMachine({
                  serverId: entry.serverId,
                  machineId: entry.machine.id,
                })
              }
              testID={`${props.testID}.card.${entry.machine.id}`}
            />
          </View>
        ))}
      </CardGrid>
    </View>
  );
}

const FleetMachineCard = React.memo(function FleetMachineCard(
  props: Readonly<{
    entry: FleetMachine;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
    hasUpdate: boolean;
    agents: React.ComponentProps<typeof MachineCliLogoRow>['agents'];
    onOpen: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { entry } = props;
  const activity = useMachineActivity(entry.online === false ? entry.machine : null);
  const availability = useMachineResourceSummary({
    serverId: entry.serverId,
    machineId: entry.machine.id,
  });
  const working = useMachineWorkingCount({
    serverId: entry.serverId,
    machineId: entry.machine.id,
  });
  const line = entry.online === null ? t('common.unknown') : entry.online
    ? t('systemStatus.machine.online')
    : t('settingsOverview.machineLastSeen', {
        lastSeen: formatLastSeen(activity?.activeAt ?? 0),
      });
  const tiles =
    props.metrics.length === 0 ? undefined : entry.online &&
      availability?.kind !== 'not_reported' ? (
      <MachineSummaryStrip
        availability={availability}
        style={props.style}
        metrics={props.metrics}
        layout="tiles"
      />
    ) : (
      <Text numberOfLines={2} style={styles.cardQuiet}>
        {entry.online === null ? t('common.unknown') : entry.online
          ? t('machineSummary.olderHappier')
          : t('machines.widgets.body.common.offline')}
      </Text>
    );
  const facts =
    props.agents.length > 0 ? (
      <MachineCliLogoRow
        testID={`${props.testID}.agents`}
        agents={props.agents}
      />
    ) : working > 0 ? (
      t('machineDetailPage.work.working', { count: working })
    ) : (
      t('machineDetailPage.work.none')
    );
  return (
    <WidgetFrame
      testID={props.testID}
      frameStyle="card"
      placement="home"
      bodyHeight="content"
      onOpen={props.onOpen}
      accessibilityLabel={t('machines.widgets.body.fleet.openMachine', { machine: entry.name })}
      title={entry.name}
      source={[entry.thisComputer ? t('settingsMachines.thisComputerTitle') : null, line].filter(Boolean).join(' · ')}
      sourcePlacement="below"
      mark={<Icon
        name={resolveMachineKindGlyph({ isThisComputer: entry.thisComputer, platform: entry.machine.metadata?.platform })}
        size={20}
        color={entry.online ? theme.colors.text.secondary : theme.colors.text.tertiary}
      />}
      body={{ kind: 'content', children: <MachineCardBody tiles={tiles} /> }}
      facts={facts}
      menu={props.hasUpdate ? (
          <RoundButton
            testID={`${props.testID}.update`}
            size="small"
            display="secondary"
            title={t('settingsOverview.update')}
            onPress={() => router.push(UPDATES_ROUTE as never)}
          />
      ) : null}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  word: {
    ...Typography.variant('meta'),
    ...Typography.default('semiBold'),
  },
  // The block reads under the name: its left edge is the rows' title column.
  need: {
    paddingLeft: resolveItemTextColumnInset('compact'),
    paddingBottom: theme.space.s8,
    gap: theme.space.s2,
  },
  doing: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  needAction: {
    flexDirection: 'row',
    marginTop: theme.space.s6,
  },
  rest: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  label: {
    ...Typography.variant('meta'),
    ...Typography.default('semiBold'),
    color: theme.colors.text.secondary,
    marginTop: theme.space.s4,
  },
  card: {
    flex: 1,
  },
  cardQuiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s16,
  },
}));

