import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import {
  collectMachineAttention,
  type MachineAttentionEntry,
} from '@/components/machines/attention/collectMachineAttention';
import {
  MACHINE_CARD_BODY_WITH_TILES_HEIGHT_PX,
  MachineCardBody,
} from '@/components/machines/index/MachineCardBody';
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
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useActiveServerAccountScope, useAllMachines, useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useMachinesCapabilitySnapshots } from '@/updates/machineCapabilitySnapshots';
import { useMachineUpdateRuns } from '@/updates/machineUpdateRuns';
import { buildRemoteMachineUpdateFacts } from '@/updates/remoteCliUpdateItems';
import { useThisComputerCliUpdate } from '@/updates/useThisComputerCliUpdate';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
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
  thisComputer: boolean;
}>;

/**
 * The fleet's order (lab `FL` "Order"): this computer first, then by name, offline last. Who needs the person
 * is said by the needs-you blocks above (worst first, the Machines page's own list), so calm rows never reorder
 * while the person looks.
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
export function useMachineFleetModel() {
  const reachabilityRevision = useMachineReachabilityRevision();
  const serverId = useActiveServerSnapshot().serverId;
  const accountScope = useActiveServerAccountScope(serverId);
  const allMachines = useAllMachines();
  // App data can arrive before this Home's machine list: until the list has been read, an empty fleet
  // means "still reading", never "no machines" (the same readiness owner as the Setup checklist).
  const settled = useIsMachineListSettled(serverId);
  const status = useMachineListStatusForServer(serverId);
  const refresh = React.useCallback(() => {
    fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), { tag: 'MachineFleet.refresh' });
  }, []);
  const nowMs = useMachinePresenceNowMs(allMachines);
  const thisComputerMachineId = useThisComputerMachineId();
  const fleet = React.useMemo(() => {
    // A replaced identity (the same computer before a reinstall) is not a machine to show or count.
    const visible = allMachines.filter((machine) => !isMachineReplaced(machine) && isMachineVisibleForLaunchSelection(machine));
    const names = resolveMachineDisplayNames(visible);
    return orderFleetMachines(visible.map((machine) => {
      const reachability = resolveMachineReachability(accountScope, machine, nowMs);
      return { key: JSON.stringify([serverId, machine.id]), serverId, machine,
        name: names.get(machine.id) ?? machine.id, online: reachability === 'unknown' ? null : reachability === 'reachable', thisComputer: machine.id === thisComputerMachineId };
    }));
  }, [accountScope, allMachines, nowMs, reachabilityRevision, serverId, thisComputerMachineId]);
  const attention = React.useMemo(() => collectMachineAttention([{ serverId, accountScope, serverName: '', status,
    machines: fleet.map((entry) => entry.machine) }], nowMs), [accountScope, fleet, nowMs, serverId, status]);
  const needs = React.useMemo(() => selectAttentionSubjects(attention.entries), [attention.entries]);
  const needsByKey = React.useMemo(() => new Map(needs.map((entry) => [entry.key, entry])), [needs]);
  return { serverId, status, settled, refresh, fleet, needs, needsByKey };
}

function FleetBody(props: MachineWidgetBodyProps) {
  const size = useMachineWidgetSize();
  const device = useMachineSummarySettingValue();
  const { style, metrics } = resolveFleetPresentation(props.input, device);
  const { serverId, status, settled: machineListSettled, refresh, fleet, needs, needsByKey } = useMachineFleetModel();
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
  if (fleet.length === 0) {
    return <MachineWidgetState kind="empty" title={t('machines.widgets.body.fleet.noMachines')}
      action={{ label: t('machines.widgets.body.fleet.addMachine'), onPress: openIndex }} testID={props.testID} />;
  }
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
  const offline = ordered.filter((entry) => entry.online === false);
  const unknown = ordered.filter((entry) => entry.online === null);
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
  const offlineRows = offline.length > 0 ? (
    <>
      <Text style={styles.label}>{t('machines.widgets.body.fleet.offlineGroup', { count: offline.length })}</Text>
      {rows(offline, false)}
    </>
  ) : null;
  if (size === 'full') {
    const half = Math.ceil(online.length / 2);
    return <MachineWidgetColumn testID={props.testID}>{freshness}<MachineWidgetTwoColumns lead={rows(online.slice(0, half), false)}
      rest={<>{rows(online.slice(half), false)}{offlineRows}</>} /></MachineWidgetColumn>;
  }
  return <MachineWidgetColumn testID={props.testID}>{freshness}{rows(online, false)}{offlineRows}</MachineWidgetColumn>;
}

/**
 * The rows' order, held while the person looks (lab FL "Order"): worst first, then calm with this computer
 * first, offline last — computed once; a machine that recovers keeps its place, a new machine joins the end.
 */
function useFleetRowOrder(fleet: readonly FleetMachine[], needs: readonly MachineAttentionEntry[]): readonly string[] {
  const needKeys = new Set(needs.map((entry) => entry.key));
  const fresh = [...needs.map((entry) => entry.key), ...fleet.filter((entry) => !needKeys.has(entry.key)).map((entry) => entry.key)];
  const held = React.useRef<readonly string[]>([]);
  const next = mergeStableProcessOrder(held.current, fresh);
  if (next.length !== held.current.length || next.some((key, index) => key !== held.current[index])) held.current = next;
  return held.current;
}

/** "4 others are calm · studio is offline": the machines a small size does not list, in one quiet line. */
export function describeRest(calm: readonly FleetMachine[], offline: readonly FleetMachine[], listed: number): string | null {
  const parts: string[] = [];
  if (calm.length > 0) parts.push(listed > 0 ? t('machines.widgets.body.fleet.othersCalm', { count: calm.length }) : t('machines.widgets.body.fleet.allCalm', { count: calm.length }));
  if (offline.length === 1) parts.push(t('machines.widgets.body.fleet.oneOffline', { machine: offline[0]!.name }));
  else if (offline.length > 1) parts.push(t('machines.widgets.body.fleet.manyOffline', { count: offline.length }));
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
  const target = React.useMemo(() => ({ serverId: entry.serverId, machineId: entry.machine.id }), [entry.machine.id, entry.serverId]);
  const availability = useMachineResourceSummary(target);
  const working = useMachineWorkingCount(target);
  const reason = need ? selectHeadlineReason(need.attention) : null;
  const tone = reason ? resolveMachineAttentionWordColor(theme.colors) : null;
  const word = reason ? describeMachineAttentionWord(reason) : null;
  const subtitle = entry.online === null ? t('common.unknown') : !entry.online
    ? t('settingsOverview.machineLastSeen', { lastSeen: formatLastSeen(entry.machine.activeAt ?? 0) })
    : working > 0 ? t('machineDetailPage.work.working', { count: working }) : t('machineDetailPage.work.none');
  const strip = entry.online && props.metrics.length > 0 && availability?.kind !== 'not_reported'
    ? <MachineSummaryStrip availability={availability} style={props.style} metrics={props.metrics} layout="under" testID={`${props.testID}.strip`} />
    : undefined;
  const doing = entry.online && !props.compact
    ? <Text numberOfLines={1} style={styles.doing}>{subtitle}</Text>
    : undefined;
  const header = (
    <Item testID={props.testID} title={entry.name} titleEllipsizeMode="middle" subtitle={doing ? undefined : subtitle} titleAccessory={doing}
      icon={<Icon name={entry.thisComputer ? 'laptop' : 'desktop'} color={entry.online ? theme.colors.text.secondary : theme.colors.text.tertiary} />}
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
  const accountScope = useActiveServerAccountScope(props.serverId);
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
        lastSeen: formatLastSeen(entry.machine.activeAt ?? 0),
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
  const footerLeft =
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
  // The card is the action (its chevron); Update is its own control over the footer, never a button in a button.
  return (
    <View style={styles.cardBody}>
      <HappierPressable
        testID={`${props.testID}.open`}
        onPress={props.onOpen}
        accessibilityRole="button"
        accessibilityLabel={t('machines.widgets.body.fleet.openMachine', { machine: entry.name })}
        style={styles.cardBody}
      >
        <MachineCardBody
          testID={props.testID}
          name={entry.name}
          line={line}
          tag={entry.thisComputer ? t('settingsMachines.thisComputerTitle') : null}
          mark={
            <Icon
              name={entry.thisComputer ? 'laptop' : 'desktop'}
              size={20}
              color={entry.online ? theme.colors.text.secondary : theme.colors.text.tertiary}
            />
          }
          tiles={tiles}
          footerLeft={footerLeft}
        />
      </HappierPressable>
      {props.hasUpdate ? (
        <View style={styles.cardUpdate}>
          <RoundButton
            testID={`${props.testID}.update`}
            size="small"
            display="secondary"
            title={t('settingsOverview.update')}
            onPress={() => router.push(UPDATES_ROUTE as never)}
          />
        </View>
      ) : null}
    </View>
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
    minHeight: MACHINE_CARD_BODY_WITH_TILES_HEIGHT_PX,
  },
  cardBody: {
    flex: 1,
  },
  cardUpdate: {
    position: 'absolute',
    right: 16,
    bottom: 12,
  },
  cardQuiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s16,
  },
}));

