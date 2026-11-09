import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { isGuardRestoration } from '@/components/machines/guard/activity/guardActivityPresentation';
import { MachineActivityRow } from '@/components/machines/guard/activity/MachineActivityRow';
import { useGuardWayBack } from '@/components/machines/guard/activity/useGuardWayBack';
import { Text } from '@/components/ui/text/Text';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { Typography } from '@/constants/Typography';
import { useMachineActivity } from '@/hooks/machine/useMachineActivity';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { isMachineGuardOn, useMachinesGuardActivity } from '@/sync/domains/machines/guard/useMachineGuardView';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readSyncedMachineResourcesPolicy } from '@/sync/domains/machines/resources/machineResourcesPolicy';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import type { MachineGuardStatus } from '@/sync/domains/machines/guard/machineGuardStore';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { getPreferredLanguage, t } from '@/text';

import {
  MachineWidgetColumn,
  MachineWidgetSectionLabel,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetFreshness,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetTarget,
} from './machineWidgetKit';

/** How many receipts each size lists (lab `aBody`); the rest is on the Activity page. */
const ROWS: Readonly<Record<WidgetSizeV1, number>> = {
  small: 1,
  medium: 4,
  wide: 4,
  full: 5,
  tall: 8,
  large: 8,
};
/** One query for every size: the week, every kind, so the counts under the list are the week's. */
const WEEK = { range: '7d', filter: 'all' } as const;

type MachineActivityReading = Readonly<{
  status: MachineGuardStatus;
  entries: readonly MachineGuardActivityRowV1[] | null;
  offline: boolean;
  guardOn: boolean | null;
  name: string;
  recipient: boolean;
  retry: () => void;
}>;
type ActivityReceipt = Readonly<{
  entry: MachineGuardActivityRowV1;
  target: MachineWidgetTarget;
  place: string | null;
  readOnly: boolean;
}>;

/**
 * Activity (rw:AC): what Happier did on its own — what, when, on which machine, what came of it and the
 * way back. One machine, or (no machine bound) every machine of the Home. Each machine's receipts come
 * from plan 50's Activity read for that machine, mounted row-locally so each one demands and releases
 * its own read; nothing here lists, polls or merges anything the owner does not answer.
 */
export function MachineActivityWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  const size = useMachineWidgetSize();
  const machineIds = useActivityMachineIds(target, props.serverId);
  const serverId = target?.serverId ?? props.serverId;
  // Plan 50's Activity read, composed per machine at its owner (one read per machine; no aggregate).
  const activities = useMachinesGuardActivity({ serverId, machineIds, ...WEEK });
  const facts = useActivityMachineFacts(serverId, machineIds);
  const readings = React.useMemo(() => {
    const byMachine: Record<string, MachineActivityReading> = {};
    activities.forEach((activity, index) => {
      const fact = facts[index];
      if (!fact) return;
      byMachine[activity.machineId] = { status: activity.status, entries: activity.list?.entries ?? null, offline: activity.offline,
        guardOn: fact.guardOn, name: fact.name, recipient: fact.recipient, retry: activity.retry };
    });
    return byMachine;
  }, [activities, facts]);
  useWidgetFrameBodyCaption(
    target ? null : t('machines.widgets.body.activity.allMachines'),
  );
  return (
    <ActivityContent
      size={size}
      target={target}
      serverId={serverId}
      machineIds={machineIds}
      readings={readings}
      testID={props.testID}
    />
  );
}

/** The bound machine, or every visible machine of the widget's Home (the machine list owner's own projection). */
function useActivityMachineIds(
  target: MachineWidgetTarget | null,
  serverId: string,
): readonly string[] {
  const signature = storage(
    React.useCallback(
      (state: ReturnType<typeof storage.getState>) => {
        if (target) return JSON.stringify([target.machineId]);
        const machines =
          resolveServerScopedMachines({
            serverId,
            activeServerId: getActiveServerSnapshot().serverId,
            activeMachines: Object.values(state.machines).filter(
              (machine): machine is NonNullable<typeof machine> =>
                Boolean(machine),
            ),
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
          }) ?? [];
        return JSON.stringify(
          machines
            .filter((machine) => isMachineVisibleForLaunchSelection(machine))
            .map((machine) => machine.id)
            .sort(),
        );
      },
      [serverId, target],
    ),
  );
  return React.useMemo(() => JSON.parse(signature) as string[], [signature]);
}

/** Each machine's name, custody and whether any automatic rule is on, from the machine list owner. */
function useActivityMachineFacts(serverId: string, machineIds: readonly string[]) {
  const signature = storage(
    React.useCallback(
      (state: ReturnType<typeof storage.getState>) =>
        JSON.stringify(
          machineIds.map((machineId) => {
            const machine = resolveServerScopedMachine(state, serverId, machineId);
            const policy = readSyncedMachineResourcesPolicy(machine);
            const guard = policy.status === 'ready' ? (policy.policy.guard ?? null) : null;
            return {
              name: machine ? getMachineDisplayName(machine) : machineId,
              recipient: machine ? !canManageMachine(machine) : false,
              guardOn: guard ? isMachineGuardOn(guard) : null,
            };
          }),
        ),
      [machineIds, serverId],
    ),
  );
  return React.useMemo(
    () => JSON.parse(signature) as readonly Readonly<{ name: string; recipient: boolean; guardOn: boolean | null }>[],
    [signature],
  );
}

function OfflineActivityState(props: Readonly<{ serverId: string; machineId: string; machineName: string; testID: string }>) {
  const machine = storage(React.useCallback(
    (state: ReturnType<typeof storage.getState>) => resolveServerScopedMachine(state, props.serverId, props.machineId),
    [props.serverId, props.machineId],
  ));
  const activity = useMachineActivity(machine);
  return <MachineWidgetState kind="offline" machineName={props.machineName}
    lastSeenAt={activity?.activeAt ?? null} testID={props.testID} />;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function ActivityContent(
  props: Readonly<{
    size: WidgetSizeV1;
    target: MachineWidgetTarget | null;
    serverId: string;
    machineIds: readonly string[];
    readings: Readonly<Record<string, MachineActivityReading>>;
    testID: string;
  }>,
) {
  const { size, readings } = props;
  const single = props.target
    ? (readings[props.target.machineId] ?? null)
    : null;
  const open = useOpenMachinePage(
    props.target ??
      (props.machineIds[0]
        ? { serverId: props.serverId, machineId: props.machineIds[0] }
        : null),
  );
  useMachineWidgetFreshness(
    single?.offline ? { kind: 'offline' } : { kind: 'live' },
    props.testID,
  );
  const known = props.machineIds
    .map((id) => readings[id])
    .filter(
      (reading): reading is MachineActivityReading => reading !== undefined,
    );
  const receipts = React.useMemo(() => {
    const all: ActivityReceipt[] = [];
    for (const machineId of props.machineIds) {
      const reading = readings[machineId];
      for (const entry of reading?.entries ?? []) {
        all.push({
          entry,
          target: { serverId: props.serverId, machineId },
          place: props.target ? null : reading!.name,
          readOnly: reading!.recipient || reading!.offline,
        });
      }
    }
    return all.sort((a, b) => b.entry.at - a.entry.at);
  }, [props.machineIds, props.serverId, props.target, readings]);

  if (single?.status === 'not_reported')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={single.name}
        testID={props.testID}
      />
    );
  const answered = known.filter((reading) => reading.entries !== null);
  if (answered.length === 0) {
    if (single?.offline)
      return (
        <OfflineActivityState
          serverId={props.serverId}
          machineId={props.target?.machineId ?? props.machineIds[0]!}
          machineName={single.name}
          testID={props.testID}
        />
      );
    const failed =
      known.length > 0 &&
      known.every(
        (reading) =>
          reading.status === 'error' ||
          reading.status === 'not_reported' ||
          reading.offline,
      );
    if (failed && known.some((reading) => reading.status === 'error')) {
      return (
        <MachineWidgetState
          kind="error"
          onRetry={() => {
            for (const reading of known) reading.retry();
          }}
          testID={props.testID}
        />
      );
    }
    if (!failed && props.machineIds.length > 0)
      return (
        <MachineWidgetState
          kind="loading"
          rows={Math.min(ROWS[size], 4)}
          testID={props.testID}
        />
      );
  }
  if (receipts.length === 0) {
    const allOff =
      known.length > 0 && known.every((reading) => reading.guardOn === false);
    return allOff ? (
      <MachineWidgetState
        kind="empty"
        testID={`${props.testID}.notSetUp`}
        title={t('machines.widgets.body.activity.notSetUpTitle')}
        reason={t('machines.widgets.body.activity.notSetUpBody')}
        {...(known.some((reading) => !reading.recipient)
          ? {
              action: {
                label: t('machines.widgets.body.activity.setUp'),
                onPress: () => open({ id: 'guard' }),
              },
            }
          : {})}
      />
    ) : (
      <MachineWidgetState
        kind="empty"
        testID={`${props.testID}.nothing`}
        title={t('machines.widgets.body.activity.emptyTitle')}
        reason={t('machines.widgets.body.activity.emptyBody')}
      />
    );
  }

  const today = startOfDay(Date.now());
  const todayCount = receipts.filter(
    (receipt) => receipt.entry.at >= today,
  ).length;
  const undoable = receipts.filter(
    (receipt) =>
      receipt.entry.undoneAt === undefined &&
      (receipt.entry.wayBack ?? []).some(isGuardRestoration),
  ).length;
  const week = t('machines.widgets.body.activity.week', {
    count: receipts.length,
    undoable,
  });
  const shown = receipts.slice(0, ROWS[size]);
  const openActivity = () => open({ id: 'guard', page: 'activity' });
  const list = (rows: readonly ActivityReceipt[]) => (
    <View accessibilityRole="list">
      {rows.map((receipt) => (
        <ActivityEntryRow
          key={`${receipt.target.machineId}:${receipt.entry.id}`}
          receipt={receipt}
          onOpen={openActivity}
        />
      ))}
    </View>
  );
  const latest = (
    <MachineWidgetSectionLabel
      label={t('machines.widgets.body.activity.latest')}
      meta={
        todayCount > 0
          ? t('machines.widgets.body.activity.today', { count: todayCount })
          : null
      }
    />
  );
  if (size === 'small')
    return (
      <MachineWidgetColumn testID={props.testID}>
        {latest}
        {list(shown)}
      </MachineWidgetColumn>
    );
  if (size === 'wide') {
    const half = Math.ceil(shown.length / 2);
    return (
      <MachineWidgetTwoColumns
        lead={<View testID={props.testID}>{list(shown.slice(0, half))}</View>}
        rest={list(shown.slice(half))}
      />
    );
  }
  if (size === 'medium') {
    return (
      <MachineWidgetColumn testID={props.testID}>
        {latest}
        {list(shown)}
        <Text style={styles.caption}>{week}</Text>
      </MachineWidgetColumn>
    );
  }
  if (size === 'full')
    return (
      <MachineWidgetColumn testID={props.testID}>
        {list(shown)}
      </MachineWidgetColumn>
    );
  if (size === 'tall') {
    return (
      <MachineWidgetColumn testID={props.testID}>
        {groupByDay(shown).map((group) => (
          <View key={group.dayStart} style={styles.day}>
            <MachineWidgetSectionLabel
              label={describeDay(group.dayStart, today)}
            />
            {list(group.receipts)}
          </View>
        ))}
        <Text style={styles.caption}>{week}</Text>
      </MachineWidgetColumn>
    );
  }
  return (
    <MachineWidgetColumn testID={props.testID}>
      {list(shown)}
      <Text
        style={styles.caption}
      >{`${week}. ${t('machines.widgets.body.activity.weekLong')}`}</Text>
    </MachineWidgetColumn>
  );
}

function groupByDay(
  receipts: readonly ActivityReceipt[],
): readonly Readonly<{
  dayStart: number;
  receipts: readonly ActivityReceipt[];
}>[] {
  const groups: { dayStart: number; receipts: ActivityReceipt[] }[] = [];
  for (const receipt of receipts) {
    const dayStart = startOfDay(receipt.entry.at);
    const last = groups[groups.length - 1];
    if (last && last.dayStart === dayStart) last.receipts.push(receipt);
    else groups.push({ dayStart, receipts: [receipt] });
  }
  return groups;
}

function describeDay(dayStart: number, today: number): string {
  if (dayStart === today) return t('machines.widgets.body.activity.todayGroup');
  if (dayStart === startOfDay(today - 1))
    return t('machines.widgets.body.activity.yesterdayGroup');
  return new Intl.DateTimeFormat(getPreferredLanguage(), {
    weekday: 'long',
  }).format(dayStart);
}

/** One receipt through the one Activity row; its way back runs on its own machine (Resume, Start again, Undo). */
const ActivityEntryRow = React.memo(function ActivityEntryRow(
  props: Readonly<{ receipt: ActivityReceipt; onOpen: () => void }>,
) {
  const wayBack = useGuardWayBack(props.receipt.target);
  return (
    <MachineActivityRow
      entry={props.receipt.entry}
      pendingId={wayBack.pendingId}
      onWayBack={wayBack.run}
      readOnly={props.receipt.readOnly}
      onPress={props.onOpen}
      {...(props.receipt.place ? { place: props.receipt.place } : {})}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    marginTop: 'auto',
  },
  day: {
    gap: theme.space.s4,
  },
}));
