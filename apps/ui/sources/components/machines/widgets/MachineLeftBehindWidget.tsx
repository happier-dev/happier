import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { formatMachineDuration } from '@/components/machines/durationWords';
import { useProcessOwnerTitles } from '@/components/machines/processes/processOwnerIdentity';
import {
  buildMachineProcessesView,
  type ProcessesSort,
} from '@/components/machines/processes/processesPresentation';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { selectMachineProcessesLeftBehind } from '@/sync/domains/machines/processes/selectMachineProcessesLeftBehind';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import {
  MachineProcessesHero,
  MachineProcessesWidgetGate,
  MachineProcessesWidgetRows,
  MachineWidgetSectionLabel,
  readMachineProcessesWidgetAnswer,
  readMachineProcessesWidgetFreshness,
} from './machineProcessesWidgetParts';
import {
  MachineWidgetColumn,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetFreshness,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetTarget,
} from './machineWidgetKit';

const BY_MEMORY: ProcessesSort = { key: 'memory', direction: 'descending' };
const DAY_MS = 86_400_000;
/** Rows each size has room for (lab `rw` LB); Small has no list, Full lists them all. */
const ROWS: Readonly<Record<WidgetSizeV1, number | undefined>> = {
  small: 0,
  wide: 3,
  medium: 4,
  full: undefined,
  tall: undefined,
  large: undefined,
};

/**
 * "Left behind" (plan 60 EU-6, lab `rw` LB): processes Happier started whose session or terminal is gone —
 * how many, what they hold, the Processes tab's own rows and one button. Clean up never stops anything here:
 * it opens the Processes tab, where the two-pass cleanup (plan 30) reviews and confirms the same set.
 */
export function MachineLeftBehindWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.common.unknownMachine')}
        testID={props.testID}
      />
    );
  return <LeftBehindBody target={target} testID={props.testID} />;
}

function describeOldest(
  startedAtMs: readonly number[],
  nowMs: number,
): string | null {
  if (startedAtMs.length === 0) return null;
  const age = Math.max(0, nowMs - Math.min(...startedAtMs));
  // Whole days once it is a day old ("9 d"), the duration words below that ("40 min").
  return formatMachineDuration(
    age >= DAY_MS ? Math.round(age / DAY_MS) * DAY_MS : age,
  );
}

function LeftBehindBody(
  props: Readonly<{ target: MachineWidgetTarget; testID: string }>,
) {
  const { target, testID } = props;
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(target);
  // The same key as the Overview's attribution read: one watch for every surface showing this machine.
  const processes = useMachineProcesses({
    serverId: target.serverId,
    machineId: target.machineId,
    scope: 'happier',
    view: 'owners',
    enabled: facts.online === true,
  });
  useMachineWidgetFreshness(
    readMachineProcessesWidgetFreshness(processes, facts.online),
    testID,
  );
  const answer = readMachineProcessesWidgetAnswer(processes);
  const titles = useProcessOwnerTitles(answer?.owners, target.serverId);
  const set = React.useMemo(
    () => selectMachineProcessesLeftBehind(answer?.leftBehind ?? []),
    [answer?.leftBehind],
  );
  const items = React.useMemo(
    () =>
      answer
        ? buildMachineProcessesView({
            answer,
            scope: 'happier',
            sort: BY_MEMORY,
            ownerTitle: (owner) => titles.get(owner.rowId) ?? null,
          }).items.filter((item) => item.kind === 'leftBehind')
        : [],
    [answer, titles],
  );
  const open = useOpenMachinePage(target);
  const openProcesses = React.useCallback(
    () => open({ id: 'processes', filter: 'leftBehind' }),
    [open],
  );

  if (!answer)
    return (
      <MachineProcessesWidgetGate
        processes={processes}
        facts={facts}
        rows={2}
        testID={testID}
      />
    );
  if (set.count === 0)
    return (
      <MachineWidgetState
        kind="empty"
        title={t('machines.widgets.body.leftBehind.emptyTitle')}
        reason={t('machines.widgets.body.leftBehind.emptyBody')}
        testID={testID}
      />
    );

  const oldest = describeOldest(
    set.items.map((row) => row.startedAtMs),
    Date.now(),
  );
  const caption = !facts.online
    ? t('machines.widgets.body.leftBehind.asOf', {
        time: formatAsOfTime(answer.capturedAtMs),
      })
    : set.memoryBytes !== null && oldest
      ? t('machines.widgets.body.leftBehind.holding', {
          amount: formatMachineBytes(set.memoryBytes, 'memory'),
          age: oldest,
        })
      : oldest
        ? t('machines.widgets.body.leftBehind.holdingUnknown', { age: oldest })
        : '';
  const hero = (
    <MachineProcessesHero
      testID={`${testID}.count`}
      label={t('machines.widgets.machine_left_behind')}
      value={String(set.count)}
      unit={t('machines.widgets.body.leftBehind.processes', {
        count: set.count,
      })}
      caption={caption}
      quiet={!facts.online}
    />
  );
  // Offline: the last known count, and no action until the machine is back (lab `rw` LB "Machine offline").
  const action = facts.online ? (
    <View style={styles.actions}>
      <RoundButton
        size="small"
        display="secondary"
        title={t('machines.widgets.body.leftBehind.cleanUp')}
        onPress={openProcesses}
        accessibilityLabel={t('machines.widgets.body.leftBehind.cleanUpLabel', {
          count: set.count,
          machine: facts.name,
        })}
        testID={`${testID}.cleanUp`}
      />
      <Text numberOfLines={1} style={styles.note}>
        {size === 'small'
          ? t('machines.widgets.body.leftBehind.ownerEnded')
          : size === 'wide'
            ? ''
            : t('machines.widgets.body.leftBehind.nothingStops')}
      </Text>
    </View>
  ) : (
    <Text style={styles.note}>
      {t('machines.widgets.body.leftBehind.offlineNote', {
        machine: facts.name,
      })}
    </Text>
  );
  const limit = ROWS[size];
  const rows = (
    <MachineProcessesWidgetRows
      serverId={target.serverId}
      machineId={target.machineId}
      machineName={facts.name}
      items={limit === undefined ? items : items.slice(0, limit)}
      titles={titles}
      cpuCapacityCores={null}
      table={false}
      onOpen={openProcesses}
      accessibilityLabel={t('machines.widgets.body.leftBehind.tableLabel', {
        machine: facts.name,
      })}
      testID={`${testID}.rows`}
    />
  );
  const label = (
    <MachineWidgetSectionLabel
      title={t('machines.widgets.body.leftBehind.stillRunning', {
        machine: facts.name,
      })}
      meta={t('machines.widgets.body.leftBehind.memory')}
    />
  );

  if (size === 'small' || size === 'tall')
    return (
      <MachineWidgetColumn testID={testID}>
        {hero}
        <View style={styles.end}>{action}</View>
      </MachineWidgetColumn>
    );
  if (size === 'wide')
    return (
      <MachineWidgetTwoColumns
        lead={
          <>
            {hero}
            <View style={styles.end}>{action}</View>
          </>
        }
        rest={rows}
      />
    );
  if (size === 'medium')
    return (
      <MachineWidgetColumn testID={testID}>
        {hero}
        {label}
        {rows}
        <View style={styles.end}>{action}</View>
      </MachineWidgetColumn>
    );
  return (
    <MachineWidgetTwoColumns
      lead={
        <>
          {hero}
          <Text style={styles.explanation}>
            {t('machines.widgets.body.leftBehind.explanation')}
          </Text>
          <View style={styles.end}>{action}</View>
        </>
      }
      rest={
        <>
          {label}
          {rows}
        </>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minWidth: 0,
  },
  note: {
    ...Typography.variant('meta'),
    flexShrink: 1,
    color: theme.colors.text.tertiary,
  },
  explanation: {
    ...Typography.variant('meta'),
    maxWidth: 300,
    color: theme.colors.text.secondary,
  },
  end: {
    marginTop: 'auto',
  },
}));
