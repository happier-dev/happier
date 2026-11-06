import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  HappierDataMetric,
  IntervalTimeline,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import {
  useAllMachines,
  useSessionListRowsByServerId,
} from '@/sync/store/hooks';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import {
  UsageBodyInsufficient,
  UsageBodyReadFailed,
  isUsageReadFailed,
  UsageBodyReading,
  UsageCoverageLine,
  isUsageReadOutstanding,
  usageAgentTitle,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import {
  formatUsageClockMinutes,
  formatUsageDuration,
  groupUsageTodayLanes,
  readUsageWorkSessionId,
  sumUsageWaitingOnYouMs,
} from './usageHowYouWorkPresentation';
import { UsageDayStyleBody } from './UsageChartStyleBodies';

const MINUTE_MS = 60_000;
/** Axis marks every three hours of the day; the timeline drops any that would crowd a neighbour. */
const TICK_STEP_MINUTES = 180;

function hourTicks(endMinutes: number): number[] {
  const ticks: number[] = [];
  for (let minute = TICK_STEP_MINUTES; minute < endMinutes; minute += TICK_STEP_MINUTES) ticks.push(minute);
  return ticks;
}
/** Below this body width a timeline row cannot place its clock axis; the exact rows remain. */
const PLOT_MIN_WIDTH_PX = 320;

/** One body per widget: its Style own-input picks the encoding of the same question. */

function selectMachineDisplayNames(machines: readonly Machine[]): Readonly<Record<string, string>> {
  return Object.fromEntries(resolveMachineDisplayNames(machines));
}

export function UsageParallelWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  // Lanes is the declared default at every size; Machine timeline is the retained original.
  if (style !== 'timeline') return <UsageDayStyleBody {...props} style={style === 'dial' ? 'dial' : 'lanes'} />;
  return <UsageParallelWidgetOriginal {...props} />;
}

/**
 * "Today, in parallel": every witnessed busy span and wait of today's work, by machine, on the
 * query's own clock. Agent time (summed per run) and busy clock time (their union) stay separate
 * numbers; a run with no recorded end draws only its start.
 */
function UsageParallelWidgetOriginal(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const width = useWidgetPresentation()?.geometry?.width;
  const sessionHomes = React.useMemo(() => [props.serverId], [props.serverId]);
  const sessionRows = useSessionListRowsByServerId(sessionHomes);
  const sessions = sessionRows[props.serverId];
  const isSessionVisible = useSessionRecordingVisibility();
  // Lanes consume display names, never daemon runtime/presence: select the names so
  // live resource publications cannot re-render the chart.
  const selectedMachineNames = useAllMachines(selectMachineDisplayNames);
  const machineNames = React.useMemo(() => new Map(Object.entries(selectedMachineNames)), [selectedMachineNames]);
  const howYouWork = props.slice.howYouWork ?? null;
  const today =
    howYouWork?.detailStatus === 'unknown'
      ? null
      : (howYouWork?.todayInParallel ?? null);
  const lanes = howYouWork?.intervals?.lanes;
  const groups = React.useMemo(
    () =>
      today && lanes
        ? groupUsageTodayLanes(lanes, today, {
            session: (workId) => {
              const sessionId = readUsageWorkSessionId(workId);
              const renderable = sessionId && isSessionVisible({ sessionId, serverId: props.serverId }) ? sessions?.[sessionId] : undefined;
              return renderable
                ? getSessionName(renderable, props.serverId)
                : t('usage.board.howYouWork.unnamedRun');
            },
            machine: (machineId) =>
              (machineId ? machineNames.get(machineId) : undefined) ??
              t('usage.board.howYouWork.unknownMachine'),
            agent: (agentId) => usageAgentTitle(agentId),
            agentColor: (agentId) => getAgentIdentityColor(theme, agentId),
            waitColor: theme.colors.state.warning.foreground,
          })
        : [],
    [today, lanes, sessions, machineNames, theme, props.serverId, isSessionVisible],
  );
  const intervals = React.useMemo(
    () => groups.flatMap((group) => group.intervals),
    [groups],
  );
  useWidgetFrameBodyCaption(
    today && today.maxParallel > 1
      ? t('usage.board.howYouWork.peakAtOnce', { count: today.maxParallel })
      : t('usage.today'),
  );
  if (!today) {
    // Until today's read answers, the body is loading, never "aren't readable here".
    if (isUsageReadOutstanding(props.slice, ['how_you_work']))
      return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: ['how_you_work'] }} />;
    if (isUsageReadFailed(props.slice, ['how_you_work']))
      return <UsageBodyReadFailed slice={props.slice} sources={['how_you_work']} testID={props.testID} onRetry={props.model.refresh} />;
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.parallelUnknownTitle')}
        reason={t('usage.board.howYouWork.parallelUnknownReason')}
      />
    );
  }
  const domain = {
    start: 0,
    end: Math.max(1, Math.round((today.endMs - today.startMs) / MINUTE_MS)),
  };
  const unknownEnds = howYouWork?.intervals?.unknownEndCount ?? 0;
  return (
    <View style={styles.body} testID={`${props.testID}.parallel`}>
      <View style={styles.metrics}>
        <HappierDataMetric
          theme={chartTheme}
          label={t('usage.board.howYouWork.agentTimeToday')}
          value={formatUsageDuration(today.agentTimeMs)}
          testID={`${props.testID}.agentTime`}
          size="stat"
          showLabel
          comparison={{
            value: formatUsageDuration(today.elapsedBusyMs),
            label: t('usage.board.howYouWork.ofClockTime'),
            meaning: 'neutral',
          }}
        />
        <HappierDataMetric
          theme={chartTheme}
          label={t('usage.board.howYouWork.waitingOnYou')}
          value={formatUsageDuration(sumUsageWaitingOnYouMs(groups))}
          testID={`${props.testID}.waiting`}
          size="stat"
          showLabel
        />
        <HappierDataMetric
          theme={chartTheme}
          label={t('usage.board.howYouWork.peakParallel')}
          value={today.maxParallel}
          testID={`${props.testID}.peak`}
          size="stat"
          showLabel
          comparison={{
            value: formatUsageDuration(today.parallelBusyMs),
            label: t('usage.board.howYouWork.withTwoOrMore'),
            meaning: 'neutral',
          }}
        />
      </View>
      {groups.length === 0 ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.idle`}
          replacesContent={false}
          title={t('usage.board.howYouWork.noRunsToday')}
        />
      ) : (
        <IntervalTimeline
            testID={`${props.testID}.lanes`}
            theme={chartTheme}
            layout="lanes"
            label={t('usage.board.howYouWork.parallelRunsLabel')}
            laneLabel={t('usage.board.howYouWork.machineLabel')}
            intervals={intervals}
            domain={domain}
            ticks={hourTicks(domain.end)}
            startLabel={t('usage.board.howYouWork.started')}
            endLabel={t('usage.board.howYouWork.ended')}
            unknownLabel={t('usage.board.howYouWork.notRecorded')}
            formatValue={formatUsageClockMinutes}
            size={
              width !== undefined && width < PLOT_MIN_WIDTH_PX ? 'tile' : 'full'
            }
          />
      )}
      {unknownEnds > 0 ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.unknownEnds`}
          replacesContent={false}
          title={t('usage.board.howYouWork.unknownEnds', {
            count: unknownEnds,
          })}
          reason={t('usage.board.howYouWork.unknownEndsReason')}
        />
      ) : null}
      <UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['how_you_work']}
        onRetry={props.model.refresh}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  body: { gap: 16, minWidth: 0 },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 32,
    rowGap: 12,
  },
}));
