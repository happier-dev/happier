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
  useSessionListRenderablesById,
} from '@/sync/store/hooks';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
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

const MINUTE_MS = 60_000;
/** Below this body width a timeline row cannot place its clock axis; the exact rows remain. */
const PLOT_MIN_WIDTH_PX = 320;

/**
 * "Today, in parallel": every witnessed busy span and wait of today's work, by machine, on the
 * query's own clock. Agent time (summed per run) and busy clock time (their union) stay separate
 * numbers; a run with no recorded end draws only its start.
 */
export function UsageParallelWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const width = useWidgetPresentation()?.geometry?.width;
  const sessions = useSessionListRenderablesById();
  const machines = useAllMachines();
  const machineNames = React.useMemo(
    () => resolveMachineDisplayNames(machines),
    [machines],
  );
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
              const renderable = sessionId ? sessions[sessionId] : undefined;
              return renderable
                ? getSessionName(renderable)
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
    [today, lanes, sessions, machineNames, theme],
  );
  useWidgetFrameBodyCaption(
    today && today.maxParallel > 1
      ? t('usage.board.howYouWork.peakAtOnce', { count: today.maxParallel })
      : null,
  );
  if (!today) {
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
        />
        <HappierDataMetric
          theme={chartTheme}
          label={t('usage.board.howYouWork.peakParallel')}
          value={today.maxParallel}
          testID={`${props.testID}.peak`}
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
          title={t('usage.board.howYouWork.noRunsToday')}
        />
      ) : (
        groups.map((group) => (
          <IntervalTimeline
            key={group.id}
            testID={`${props.testID}.machine.${group.id}`}
            theme={chartTheme}
            label={group.label}
            intervals={group.intervals}
            domain={domain}
            startLabel={t('usage.board.howYouWork.started')}
            endLabel={t('usage.board.howYouWork.ended')}
            unknownLabel={t('usage.board.howYouWork.notRecorded')}
            formatValue={formatUsageClockMinutes}
            size={
              width !== undefined && width < PLOT_MIN_WIDTH_PX ? 'tile' : 'full'
            }
          />
        ))
      )}
      {unknownEnds > 0 ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.unknownEnds`}
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
