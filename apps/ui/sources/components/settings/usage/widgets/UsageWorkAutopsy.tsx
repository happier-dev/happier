import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  HappierDataMetric,
  HappierDataRows,
  IntervalTimeline,
  type IntervalTimelineInterval,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import { usageMeterFill, usageSignatureAccent } from '../usageAccent';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { useUsageWork } from './useUsageWork';
import { summarizeUsageWorkSession, type UsageWorkTurnRow } from './usageWorkPresentation';
import {
  formatUsageDuration,
  readUsageWorkSessionId,
  readUsageWorkTurnId,
} from './usageHowYouWorkPresentation';
import {
  UsageWorkMarks,
  UsageWorkSectionTitle,
  usageWorkBranchName,
  usageWorkProviderUnknownLine,
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  usageWorkShortCommit,
} from './UsageWorkParts';

const PLOT_MIN_WIDTH_PX = 360;

const WAIT_LABELS = {
  permission_wait: 'usage.board.howYouWork.waitApproval',
  child_wait: 'usage.board.howYouWork.waitChild',
  user_wait: 'usage.board.howYouWork.waitReply',
} as const;

/**
 * One Session, read back: what it cost and what that is linked to, its witnessed working and waiting
 * phases with the checkpoints that fell in them, then every turn with its own exact amount and
 * evidence. Shared by Work and Recap; only the admitted usage.query slice supplies any of it.
 */
export function UsageWorkAutopsy(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  const { theme: appTheme } = useUnistyles();
  const presentation = useWidgetPresentation();
  const rowMetrics = usePageRowMetrics('list');
  const { format, sessionLabel } = useUsageWork(props.slice, props.query, props.serverId);
  const selected =
    typeof props.query.session === 'string'
      ? props.query.session
      : props.query.session?.length === 1
        ? props.query.session[0]!
        : null;
  const work = props.slice.work;
  const { metric, costBasis } = props.query;
  const autopsy = React.useMemo(
    () => (selected && work ? summarizeUsageWorkSession(work, { metric, costBasis }, selected) : null),
    [selected, work, metric, costBasis],
  );
  if (!selected) return null;
  const turns = autopsy?.turns ?? [];
  // A turn is named by its place in the witnessed order, never by its raw id.
  const ordinals = new Map<string, number>();
  for (const turn of turns)
    if (turn.turnId !== null && !ordinals.has(turn.turnId)) ordinals.set(turn.turnId, ordinals.size + 1);
  const turnLabel = (turnId: string | null) => {
    const ordinal = turnId === null ? undefined : ordinals.get(turnId);
    return ordinal === undefined
      ? t('usage.board.work.turn')
      : t('usage.board.work.turnNumber', { number: ordinal });
  };
  const evidenceLine = (turn: UsageWorkTurnRow) =>
    [
      ...turn.branches.map(usageWorkBranchName),
      ...turn.commits.map((sha) => `${t('usage.board.work.commit')} ${usageWorkShortCommit(sha)}`),
    ].join(' · ');
  const outcomeLine = (turn: UsageWorkTurnRow) =>
    turn.outcome
      ? `${usageWorkPullRequestTitle(turn.outcome.pullRequest)} · ${usageWorkPullRequestState(turn.outcome.pullRequest)}`
      : t(`usage.board.work.reason_${turn.reason === 'allocated' ? 'missing_evidence' : turn.reason}`);

  const phases = props.slice.howYouWork?.intervals;
  const accent = usageSignatureAccent(appTheme);
  const quiet = usageMeterFill(appTheme, false);
  const intervals: IntervalTimelineInterval[] = [
    ...(phases?.lanes ?? [])
      .filter((lane) => readUsageWorkSessionId(lane.workId) === selected)
      .flatMap((lane) => {
        const label = turnLabel(readUsageWorkTurnId(lane.workId));
        return [
          ...lane.busy.map((span, index) => ({
            id: `${lane.workId}:busy:${index}`,
            label,
            start: span.startMs,
            end: span.endMs,
            color: accent,
            annotation: formatUsageDuration(span.endMs - span.startMs),
          })),
          ...lane.waits.map((span) => ({
            id: `${lane.workId}:${span.evidenceId}`,
            label: t(WAIT_LABELS[span.kind]),
            start: span.startMs,
            end: span.endMs,
            color: quiet,
            pattern: 'hatched' as const,
            annotation: `${label} · ${formatUsageDuration(span.endMs - span.startMs)}`,
          })),
        ];
      }),
    // A checkpoint is one witnessed moment: the turn's own observation time, never a span.
    ...turns
      .filter((turn) => turn.checkpoints.length > 0)
      .map((turn) => ({
        id: `checkpoint:${turn.contributionId}`,
        kind: 'point' as const,
        label: t('usage.board.work.checkpoint'),
        start: turn.observedAtMs,
        end: turn.observedAtMs,
        color: appTheme.colors.text.primary,
        annotation: [turnLabel(turn.turnId), evidenceLine(turn), turn.outcome ? outcomeLine(turn) : '']
          .filter(Boolean)
          .join(' · '),
      })),
  ].sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  // The Session's own witnessed extent, so a short Session is not a sliver of a month-long period.
  const instants = intervals.flatMap((interval) =>
    [interval.start, interval.end].filter((value): value is number => value !== null),
  );
  const first = instants.length > 0 ? Math.min(...instants) : null;
  const last = instants.length > 0 ? Math.max(...instants) : null;
  const domain =
    first !== null && last !== null && last > first
      ? { start: first, end: last }
      : phases
        ? { start: phases.period.startMs, end: phases.period.endMs }
        : null;
  const width = presentation?.geometry?.width;
  const caption = { fontSize: rowMetrics.subtitle.fontSize, lineHeight: rowMetrics.subtitle.lineHeight };
  const metricLabel = metric === 'cost' ? t('usage.cost') : t('usage.tokens');
  const outcomes = autopsy?.outcomes ?? [];
  return (
    <View testID={props.testID} style={styles.body}>
      {autopsy && turns.length > 0 ? (
        <View style={styles.summary} testID={`${props.testID}.summary`}>
          <View style={styles.facts}>
            <HappierDataMetric
              theme={theme}
              size="stat"
              showLabel
              label={t('usage.board.work.autopsyTitle')}
              value={autopsy.amount ?? format(null)}
              valueFormatter={format}
              caption={sessionLabel(selected)}
            />
            <HappierDataMetric
              theme={theme}
              size="stat"
              showLabel
              label={t('usage.board.work.turns')}
              value={ordinals.size}
            />
          </View>
          <View style={styles.outcome}>
            <UsageWorkMarks
              agentIds={autopsy.agentIds}
              providers={autopsy.providers}
              serverId={props.serverId}
              testID={props.testID}
            />
            <Text style={[styles.outcomeText, caption]}>
              {[
                `${t('usage.board.work.linkedOutcome')}: ${
                  outcomes.length === 0
                    ? t('usage.board.work.noOutcome')
                    : outcomes
                        .map(
                          (outcome) =>
                            `${usageWorkPullRequestTitle(outcome.pullRequest)} · ${usageWorkPullRequestState(outcome.pullRequest)}`,
                        )
                        .join(', ')
                }`,
                usageWorkProviderUnknownLine(autopsy),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </View>
      ) : work ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.empty`}
          title={t('usage.board.work.emptyTitle')}
          reason={t('usage.board.work.emptyReason')}
        />
      ) : null}
      {phases && domain ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle caption={t('usage.board.work.phasesCaption')}>
            {t('usage.board.work.phases')}
          </UsageWorkSectionTitle>
          <IntervalTimeline
            theme={theme}
            label={t('usage.board.work.phases')}
            testID={`${props.testID}.phases`}
            intervals={intervals}
            domain={domain}
            size={width !== undefined && width < PLOT_MIN_WIDTH_PX ? 'tile' : 'full'}
            formatValue={(value) => formatUsageDuration(value - domain.start)}
            startLabel={t('usage.board.howYouWork.started')}
            endLabel={t('usage.board.howYouWork.ended')}
            unknownLabel={t('usage.board.howYouWork.notRecorded')}
          />
          {phases.unknownEndCount ? (
            <Text style={[styles.note, caption]} testID={`${props.testID}.unknownEnds`}>
              {t('usage.board.howYouWork.unknownEnds', { count: phases.unknownEndCount })} ·{' '}
              {t('usage.board.howYouWork.unknownEndsReason')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {turns.length > 0 ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle>{t('usage.board.work.turns')}</UsageWorkSectionTitle>
          <HappierDataRows
            theme={theme}
            label={t('usage.board.work.turns')}
            testID={`${props.testID}.turns`}
            density="compact"
            showProportionShares={false}
            valueFormatter={format}
            rowIds={turns.map((turn) => turn.contributionId)}
            columns={[
              { label: t('usage.board.work.turn') },
              { label: metricLabel, proportion: true },
              { label: t('usage.board.work.linkedOutcome') },
              { label: t('usage.board.work.checkpoint') },
              { label: t('usage.board.work.commit') },
            ]}
            rows={turns.map((turn) => [
              turn.turnId === null ? t('usage.board.work.reason_missing_turn') : turnLabel(turn.turnId),
              turn.amount ?? format(null),
              outcomeLine(turn),
              turn.checkpoints.join(' · '),
              evidenceLine(turn),
            ])}
          />
        </View>
      ) : null}
      <UsageCoverageLine
        slice={props.slice}
        sources={['work', 'howYouWork']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 14, minWidth: 0 },
  summary: { gap: 10, minWidth: 0 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 32, rowGap: 12 },
  outcome: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 },
  outcomeText: { ...Typography.default(), color: theme.colors.text.secondary, flexShrink: 1 },
  section: {
    gap: 10,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  note: { ...Typography.default(), color: theme.colors.text.tertiary },
}));
