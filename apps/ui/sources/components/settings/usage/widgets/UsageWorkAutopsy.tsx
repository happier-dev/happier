import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  HappierDataMetric,
  HappierDataRows,
  IntervalTimeline,
  StackedSeriesChart,
  type IntervalTimelineInterval,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { usageMeterFill, usageSignatureAccent } from '../usageAccent';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  UsageShowAllRows,
  leadingUsageRows,
  usageDimensionLabel,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { useUsageWork } from './useUsageWork';
import { useUsageChartDetails } from './usageMountedControls';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { useMachineDisplayNamesById, useSessionMetadata } from '@/sync/store/hooks';
import { findModelOptionForEffectiveModelId, getModelOptionsForSession } from '@/sync/domains/models/modelOptions';
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
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  usageWorkShortCommit,
  usageWorkRetainedChangeLine,
} from './UsageWorkParts';

const PLOT_MIN_WIDTH_PX = 360;

const WAIT_LABELS = {
  permission_wait: 'usage.board.howYouWork.waitApproval',
  child_wait: 'usage.board.howYouWork.waitChild',
  user_wait: 'usage.board.howYouWork.waitReply',
} as const;
const PHASE_LABELS = {
  read: 'usage.board.work.phase_read', change: 'usage.board.work.phase_change', execute: 'usage.board.work.phase_execute',
  delegate: 'usage.board.work.phase_delegate', compaction: 'usage.board.work.phase_compaction', unknown: 'usage.board.work.phase_unknown',
} as const;

/**
 * One Session, read back: what it cost and what that is linked to, its witnessed working and waiting
 * phases with the checkpoints that fell in them, then every turn with its own exact amount and
 * evidence. Shared by Work and Recap; only the admitted usage.query slice supplies any of it.
 */
export function UsageWorkAutopsy(
  props: UsageBodyProps & Readonly<{ /** The host body already said Work is unavailable. */ unavailableSaid?: boolean }>,
) {
  const theme = useUsagePluginTheme();
  const { theme: appTheme } = useUnistyles();
  const presentation = useWidgetPresentation();
  const rowMetrics = usePageRowMetrics('list');
  const { format, cell, datum, sessionLabel } = useUsageWork(props.slice, props.query, props.serverId);
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
  const metadata = useSessionMetadata(selected ?? '', props.serverId);
  const contributions = React.useMemo(() => new Map((work?.allocations ?? [])
    .filter(row => row.contribution.sessionId === selected).map(row => [row.contribution.id, row.contribution])), [work, selected]);
  const machineIds = React.useMemo(() => [...new Set([...contributions.values()]
    .flatMap(row => row.machineId === null ? [] : [row.machineId]))], [contributions]);
  const machineNames = useMachineDisplayNamesById(machineIds);
  const modelOptions = React.useMemo(() => new Map([...new Set([...contributions.values()]
    .flatMap(row => row.agentId === null ? [] : [row.agentId]))].map(agentId => [agentId,
      getModelOptionsForSession(agentId, metadata)])), [contributions, metadata]);
  const identityLine = (turn: UsageWorkTurnRow) => [...new Set(turn.contributionIds.map((id) => {
    const row = contributions.get(id);
    const model = row?.modelId ? findModelOptionForEffectiveModelId(modelOptions.get(row.agentId ?? '') ?? [], row.modelId)?.label
      ?? usageDimensionLabel('model', row.modelId) : t('usage.board.howYouWork.notRecorded');
    const machine = row?.machineId ? machineNames[row.machineId] ?? usageDimensionLabel('machine', row.machineId) : t('usage.board.howYouWork.notRecorded');
    return `${model} · ${machine}`;
  }))].join(', ');
  const width = presentation?.geometry?.width;
  const details = useUsageChartDetails(`${t(`usage.widgets.${props.id}`)}: ${t('usage.board.work.costOverTime')}`,
    selected !== null && Boolean(autopsy?.costTimeline.length) && (width === undefined || width >= PLOT_MIN_WIDTH_PX));
  const [turnsExpanded, setTurnsExpanded] = React.useState(false);
  const [phasesExpanded, setPhasesExpanded] = React.useState(false);
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
  const gitTime = (atMs: number) => formatWithCachedDateTimeFormatter(atMs, getPreferredLanguage(),
    { dateStyle: 'medium', timeStyle: 'short' });
  const evidenceLine = (turn: UsageWorkTurnRow) =>
    [
      ...turn.branches.map(usageWorkBranchName),
      ...turn.commits.map((sha) => {
        const moment = turn.moments.find(item => item.kind === 'commit' && item.sha === sha);
        return `${t('usage.board.work.commit')} ${usageWorkShortCommit(sha)} · ${moment ? gitTime(moment.atMs)
          : t('usage.board.howYouWork.notRecorded')}`;
      }),
    ].join(' · ');
  // This column is about the PR outcome: a turn whose commit is linked lacks a PR, not commit evidence.
  // A Session with no outcome at all says so once, in its summary, never on every turn.
  const outcomeLine = (turn: UsageWorkTurnRow) => {
    if (turn.outcome)
      return `${usageWorkPullRequestTitle(turn.outcome.pullRequest)} · ${usageWorkPullRequestState(turn.outcome.pullRequest)}`;
    if ((autopsy?.outcomes.length ?? 0) === 0) return '';
    const reason = turn.reason === 'allocated' ? 'missing_evidence' : turn.reason;
    return t(`usage.board.work.reason_${reason === 'missing_evidence' && turn.commits.length > 0 ? 'missing_pr' : reason}`);
  };

  const phases = props.slice.howYouWork?.intervals;
  // Tool calls run to the hundreds; as timeline rows they bury the answer. Only what changes the Session's course stays.
  const phaseEvents = props.slice.howYouWork?.autopsy?.events.filter(event => event.sessionId === selected
    && (event.kind === 'compaction' || event.kind === 'delegate')) ?? [];
  const accent = usageSignatureAccent(appTheme);
  const quiet = usageMeterFill(appTheme, false);
  const intervals: IntervalTimelineInterval[] = [
    ...phaseEvents.map(event => ({ id: `phase:${event.evidenceId}`, kind: 'point' as const,
      label: t(PHASE_LABELS[event.kind]), start: event.observedAtMs, end: event.observedAtMs,
      color: event.kind === 'compaction' ? accent : quiet,
      annotation: event.turnId === null ? t('usage.board.howYouWork.notRecorded') : turnLabel(event.turnId) })),
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
    // Git object times are independent of accounting observations. Missing object times create no marker.
    ...[...new Map(turns.flatMap(turn => turn.moments.map(moment => ({ turn, moment })))
      .map(row => [JSON.stringify(row.moment), row])).values()].map(({ turn, moment }) => ({
        id: `${moment.kind}:${moment.sha}`,
        kind: 'point' as const,
        label: t(`usage.board.work.${moment.kind}`),
        start: moment.atMs,
        end: moment.atMs,
        color: appTheme.colors.text.primary,
        annotation: [turnLabel(turn.turnId), gitTime(moment.atMs), evidenceLine(turn), turn.outcome ? outcomeLine(turn) : '']
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
    first !== null && last !== null
      ? { start: first, end: last }
      : phases
        ? { start: phases.period.startMs, end: phases.period.endMs }
        : null;
  const caption = { fontSize: rowMetrics.subtitle.fontSize, lineHeight: rowMetrics.subtitle.lineHeight };
  const metricLabel = metric === 'cost' ? t('usage.cost') : t('usage.tokens');
  const outcomes = autopsy?.outcomes ?? [];
  // The answer to "why is this Session expensive": where it went, largest first; the timeline above keeps the order.
  const ranked = [...turns].sort((left, right) => (right.amount ?? -1) - (left.amount ?? -1));
  const largest = ranked[0]?.amount != null && ranked[0].amount > 0 && ranked[0].turnId !== null ? ranked[0] : null;
  const largestShare = largest && autopsy?.amount ? Math.round((largest.amount! / autopsy.amount) * 100) : null;
  // A long Session leads with its largest turns; the rest fold behind the Usage show-all footer (R135 item 3).
  const shownTurns = leadingUsageRows(ranked, turnsExpanded);
  // Phases keep their witnessed order and the Session's whole extent; a long Session leads with its first ones (sweep 1110 item 16).
  const shownPhases = leadingUsageRows(intervals, phasesExpanded);
  // What every turn shares is said once in the summary, not on each row.
  const identities = new Set(turns.map(identityLine));
  const sharedIdentity = identities.size === 1 ? [...identities][0]! : null;
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
              value={autopsy.amount ?? format(null, autopsy.moneyBasis)}
              valueFormatter={value => format(value, autopsy.moneyBasis)}
              caption={sessionLabel(selected)}
            />
            <HappierDataMetric
              theme={theme}
              size="stat"
              showLabel
              label={t('usage.board.work.turns')}
              value={ordinals.size}
            />
            {largest ? (
              <HappierDataMetric
                theme={theme}
                size="stat"
                showLabel
                label={t('usage.board.work.largestTurn')}
                value={largest.amount!}
                valueFormatter={value => format(value, largest.moneyBasis)}
                caption={[turnLabel(largest.turnId), largestShare === null ? null : `${largestShare}%`].filter(Boolean).join(' · ')}
              />
            ) : null}
          </View>
          <View style={styles.outcome}>
            {/* The marks lead the line's first row; the outcome text wraps beside them, never below a lone glyph. */}
            <View style={[styles.outcomeMarks, { height: caption.lineHeight }]}>
            <UsageWorkMarks
              agentIds={autopsy.agentIds}
              providers={autopsy.providers}
              serverId={props.serverId}
              testID={props.testID}
            />
            </View>
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
                sharedIdentity,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </View>
      ) : work ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.empty`}
          replacesContent={false}
          title={t('usage.board.work.emptyTitle')}
          reason={t('usage.board.work.emptyReason')}
        />
      ) : props.unavailableSaid ? null : (
        // No Work facts were admitted for this read: say so rather than show an empty autopsy.
        <UsageBodyInsufficient
          testID={`${props.testID}.workUnavailable`}
          replacesContent={false}
          title={t('usage.board.work.workUnavailableTitle')}
          reason={t('usage.board.work.workUnavailableReason')}
        />
      )}
      {autopsy && autopsy.costTimeline.length > 0 ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle caption={autopsy.costTimelineBasis
            ? `${usageCostKindPhrase(autopsy.costTimelineBasis.kind)} · ${autopsy.costTimelineBasis.currency}`
            : t('usage.board.recap.money_unpriced')}>{t('usage.board.work.costOverTime')}</UsageWorkSectionTitle>
          <StackedSeriesChart
            {...details}
            theme={theme}
            testID={`${props.testID}.costTimeline`}
            label={t('usage.board.work.costOverTime')}
            variant="line"
            size={width !== undefined && width < PLOT_MIN_WIDTH_PX ? 'tile' : 'full'}
            valueFormatter={value => autopsy.costTimelineBasis && value !== null
              ? formatUsageCost(value, autopsy.costTimelineBasis.currency) : t('usage.board.recap.money_unpriced')}
            unknownLabel={t('usage.board.recap.money_unpriced')}
            // Labels count time since the first cost; exact values say when it was observed.
            coordinateFormatter={observedAtMs => formatUsageObservedAt(observedAtMs)}
            series={[{ id: 'cost', label: t('usage.cost'), color: accent,
              points: autopsy.costTimeline.map(point => ({ id: point.id,
                x: point.observedAtMs,
                label: formatUsageDuration(point.observedAtMs - autopsy.costTimeline[0]!.observedAtMs),
                y: point.amount })) }]}
          />
        </View>
      ) : null}
      {turns.length > 0 ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle caption={turns.length > 1 ? t('usage.board.work.largestFirst') : undefined}>{t('usage.board.work.turns')}</UsageWorkSectionTitle>
          <HappierDataRows
            theme={theme}
            label={t('usage.board.work.turns')}
            testID={`${props.testID}.turns`}
            density="compact"
            showProportionShares={false}
            valueFormatter={format}
            rowIds={shownTurns.rows.map((turn) => turn.contributionId)}
            rowDatums={shownTurns.rows.map(turn => datum(turn.turnId === null ? t('usage.board.work.reason_missing_turn') : turnLabel(turn.turnId), turn.amount, turn.moneyBasis))}
            columns={[
              { label: t('usage.board.work.turn') },
              { label: metricLabel, proportion: true },
              { label: t('usage.board.work.linkedOutcome') },
              { label: t('usage.board.work.commit') },
              { label: t('usage.board.work.linesKept') },
              { label: `${t('usage.board.page.byModel')} · ${t('common.machine')}` },
              { label: t('usage.board.work.checkpoint') },
            ]}
            rows={shownTurns.rows.map((turn) => [
              turn.turnId === null ? t('usage.board.work.reason_missing_turn') : turnLabel(turn.turnId),
              cell(turn.amount, turn.moneyBasis),
              outcomeLine(turn),
              evidenceLine(turn),
              usageWorkRetainedChangeLine(turn.retainedChanges),
              sharedIdentity === null ? identityLine(turn) : '',
              // The raw checkpoint ref is the longest and least readable fact, so it ends the row's one line.
              turn.checkpoints.join(' · '),
            ])}
          />
          <UsageShowAllRows label={`${t(`usage.widgets.${props.id}`)}: ${t('usage.board.work.turns')}`}
            total={ranked.length} hidden={shownTurns.hidden} expanded={turnsExpanded}
            onToggle={() => setTurnsExpanded(value => !value)} testID={`${props.testID}.turns.more`} />
          {turns.some(turn => turn.retainedChanges.length > 0) ?
            <Text style={[styles.note, caption]}>{t('usage.board.work.linesKeptMethod')}</Text> : null}
        </View>
      ) : null}
      {domain && intervals.length > 0 ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle caption={t('usage.board.work.phasesCaption')}>
            {t('usage.board.work.phases')}
          </UsageWorkSectionTitle>
          <IntervalTimeline
            theme={theme}
            label={t('usage.board.work.phases')}
            testID={`${props.testID}.phases`}
            intervals={shownPhases.rows}
            domain={domain}
            size={width !== undefined && width < PLOT_MIN_WIDTH_PX ? 'tile' : 'full'}
            formatValue={(value) => formatUsageDuration(value - domain.start)}
            startLabel={t('usage.board.howYouWork.started')}
            endLabel={t('usage.board.howYouWork.ended')}
            unknownLabel={t('usage.board.howYouWork.notRecorded')}
          />
          <UsageShowAllRows label={`${t(`usage.widgets.${props.id}`)}: ${t('usage.board.work.phases')}`}
            total={intervals.length} hidden={shownPhases.hidden} expanded={phasesExpanded}
            onToggle={() => setPhasesExpanded(value => !value)} testID={`${props.testID}.phases.more`} />
          {phases?.unknownEndCount ? (
            <Text style={[styles.note, caption]} testID={`${props.testID}.unknownEnds`}>
              {t('usage.board.howYouWork.unknownEnds', { count: phases.unknownEndCount })} ·{' '}
              {t('usage.board.howYouWork.unknownEndsReason')}
            </Text>
          ) : null}
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
  summary: { gap: theme.space.s10, minWidth: 0 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s32, rowGap: theme.space.s12 },
  outcome: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.s8 },
  outcomeMarks: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  outcomeText: { ...Typography.default(), color: theme.colors.text.secondary, flex: 1, minWidth: 0 },
  section: {
    gap: theme.space.s10,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  note: { ...Typography.default(), color: theme.colors.text.tertiary },
}));
