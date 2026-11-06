import * as React from 'react';
import { View } from 'react-native';
import {
  UsageAgentRiver, UsageConstellation, UsageCrew, UsageDayInAgents, UsageDaylight, UsageOrbit, UsagePlanetPortrait, UsageRunLength,
  UsageChartGhost, UsagePersonalRecords, UsageScore, UsageShipped, UsageSkyOfDays, UsageSteeringTide, UsageWeekTide, type UsageChartGhostShape,
} from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { usageAgentTitle } from '@/sync/domains/usage/usageLabels';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { usageCrewLabels, usageOrbitLabels, usagePlanetLabels, usageShippedLabels, usageSkyLabels } from './usageChartLabels';
import { formatUsageDuration } from './usageHowYouWorkPresentation';
import {
  UsageBodyInsufficient, UsageBodyReadFailed, UsageBodyReading, UsageCoverageLine, isUsageReadFailed, isUsageReadOutstanding, type UsageBodyProps,
} from './usageBodyKit';
import {
  formatUsageChartMetric, usageChartClock, usageChartDateLabels, usageChartMetricName, usageChartPercent, usageChartValuesLabels,
  usageChartWeekdays, useUsageChartHost, type UsageChartMetric,
} from './usageChartHost';
import {
  projectUsageAgentShares, projectUsageConstellationModel, projectUsageDayModel, projectUsageDaylight, projectUsageRiverModel,
  projectUsageRunLengthModel, projectUsageScoreModel, projectUsageShippedModel, projectUsageSkyModel, projectUsageSteeringModel,
  projectUsageRecordFacts, projectUsagePortraitModel, projectUsageWeekHours, resolveUsageChartDay, resolveUsageChartMetric,
} from './usageChartModels';

export type UsageChartStyleBodyProps = UsageBodyProps;

const HOW_YOU_WORK = ['how_you_work'] as const;
const ACCOUNTING = ['accounting'] as const;

/** The query owner decides whether this chart reads private activity or accounting alone. */
function readUsageChartSources(slice: UsageBodyProps['slice']) {
  return slice.shownQuery.includeSessionEvidence ? HOW_YOU_WORK : ACCOUNTING;
}
const LEVEL_NAMES = () => [t('usage.board.charts.levelNone'), t('usage.board.charts.levelQuiet'), t('usage.board.charts.levelSteady'),
  t('usage.board.charts.levelBusy'), t('usage.board.charts.levelBusiest')];

/**
 * Reading, then "needs data" with its reason; one cause, one line — over the chart's empty frame when it has one.
 * While activity is still being read the chart says it is reading, even when accounting has already answered.
 */
export function UsageChartPending(props: Readonly<{ slice: UsageBodyProps['slice']; testID: string; title: string; reason: string; ghost?: React.ReactNode; onRetry: () => void }>) {
  const sources = readUsageChartSources(props.slice);
  if (isUsageReadOutstanding(props.slice, sources) || isUsageReadOutstanding(props.slice, [...sources, 'accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources }} />;
  // A failed read is unknown, never "needs data".
  if (isUsageReadFailed(props.slice, sources))
    return <UsageBodyReadFailed slice={props.slice} sources={sources} testID={props.testID} onRetry={props.onRetry} />;
  const state = <UsageBodyInsufficient testID={`${props.testID}.needsData`} title={props.title} reason={props.reason} replacesContent={!props.ghost} />;
  return props.ghost ? <View style={{ gap: 12 }}>{state}{props.ghost}</View> : state;
}

/** The chart's frame while its measure has nothing to draw; the clock axis is the host's. */
function useChartGhost(serverId: string | null) {
  const host = useUsageChartHost(serverId);
  return React.useCallback((shape: UsageChartGhostShape, testID: string, extra?: Readonly<{ count?: number; rows?: readonly string[]; ticks?: readonly string[] }>) =>
    <UsageChartGhost theme={host.theme} paint={host.paint} shape={shape} testID={`${testID}.ghost`}
      ticks={extra?.ticks ?? [0, 6, 12, 18, 24].map(usageChartClock)} {...(extra?.rows ? { rows: extra.rows } : {})} {...(extra?.count ? { count: extra.count } : {})} />,
  [host.theme, host.paint]);
}

function UsageChartFooter(props: Readonly<{ slice: UsageBodyProps['slice']; testID: string; onRetry: () => void }>) {
  return <UsageCoverageLine testID={`${props.testID}.coverage`} slice={props.slice} sources={readUsageChartSources(props.slice)} onRetry={props.onRetry} />;
}

function useCalendar(props: UsageBodyProps) {
  return props.slice.howYouWork?.agentCalendar ?? null;
}

type UsageAgentCalendarCoverage = NonNullable<ReturnType<typeof useCalendar>>['coverage'];
/** The selected measure has no admitted population this period (not the same as a quiet period). */
function isMeasureUnrecorded(coverage: UsageAgentCalendarCoverage, metric: UsageChartMetric): boolean {
  const owner = metric === 'busy' || metric === 'peakParallel' ? coverage.busy : metric === 'steering' ? coverage.steering : coverage.accounting;
  return owner === 'unavailable';
}

/** The frame names the Style and its measure; the definition title alone ("Rhythm") does not say which chart this is. */
export function useStyleCaption(style: string, detail?: string | null) {
  useWidgetFrameBodyCaption(detail ? `${style} · ${detail}` : style);
}

/* ═════ Rhythm · Sky of days | Week tide | Daylight ═════ */

export function UsageSkyStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'busy');
  const colourBy = props.presentation?.colourBy === 'leadingAgent' ? 'leadingAgent' : 'intensity';
  const model = React.useMemo(() => calendar ? projectUsageSkyModel(calendar, metric, colourBy, Date.now()) : null, [calendar, metric, colourBy]);
  const agents = React.useMemo(() => {
    const ids = new Set<string>();
    for (const day of model?.days ?? []) {
      if (day.leader?.kind === 'agent') ids.add(day.leader.agentId);
      if (day.leader?.kind === 'tie') day.leader.agentIds.forEach((id) => ids.add(id));
    }
    return [...ids].map(host.agent);
  }, [model, host.agent]);
  const metricName = usageChartMetricName(metric);
  const ghost = useChartGhost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputSky'), metricName);
  if (!model) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  if (calendar && (isMeasureUnrecorded(calendar.coverage, metric) || !model.days.some((day) => day.state !== 'unknown')))
    return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.metricNotRecordedTitle', { metric: metricName })} reason={t('usage.board.charts.metricNotRecordedHint')}
      ghost={ghost('sky', props.testID, { count: model.days.length, ticks: [] })} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.sky`}>
    <UsageSkyOfDays theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.skyChart`}
      label={t('usage.board.charts.skyA11y', { metric: metricName, count: model.days.length })}
      labels={usageSkyLabels({ query: props.query, metricName, formatValue: (value) => formatUsageChartMetric(metric, value), colourBy })} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageWeekTideStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'busy');
  const model = React.useMemo(() => calendar ? projectUsageWeekHours(calendar, metric) : null, [calendar, metric]);
  const ghost = useChartGhost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputWeekTide'), usageChartMetricName(metric));
  if (!model || (calendar && isMeasureUnrecorded(calendar.coverage, metric))) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID}
    ghost={calendar ? ghost('tide', props.testID, { rows: usageChartWeekdays() }) : undefined} title={calendar && isMeasureUnrecorded(calendar.coverage, metric) ? t('usage.board.charts.metricNotRecordedTitle', { metric: usageChartMetricName(metric) }) : t('usage.board.charts.needsDataTitle')}
    reason={!calendar ? t('usage.board.charts.needsCalendarReason') : isMeasureUnrecorded(calendar.coverage, metric)
      ? t('usage.board.charts.metricNotRecordedHint') : t('usage.board.charts.metricNotByHourReason', { metric: usageChartMetricName(metric) })} />;
  const weekdays = usageChartWeekdays();
  return <View style={{ gap: 12 }} testID={`${props.testID}.tide`}>
    <UsageWeekTide theme={host.theme} paint={host.paint} model={model} label={t('usage.board.charts.tideA11y', { metric: usageChartMetricName(metric) })} testID={`${props.testID}.tideChart`}
      labels={{ weekdays, clock: usageChartClock, peak: (weekday, hour, value) => t('usage.board.charts.tidePeak', { when: `${weekdays[weekday]} ${usageChartClock(hour)}`, value: formatUsageChartMetric(metric, value) }),
        values: { ...usageChartValuesLabels(), weekdayColumn: t('usage.board.charts.weekdayColumn'), formatValue: (value) => formatUsageChartMetric(metric, value), levelNames: LEVEL_NAMES() } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageDaylightStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'busy');
  const model = React.useMemo(() => calendar ? projectUsageDaylight(calendar, metric, props.slice) : null, [calendar, metric, props.slice]);
  const ghost = useChartGhost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputDaylight'), usageChartMetricName(metric));
  if (!model || (calendar && isMeasureUnrecorded(calendar.coverage, metric))) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID}
    ghost={calendar ? ghost('daylight', props.testID) : undefined} title={calendar && isMeasureUnrecorded(calendar.coverage, metric) ? t('usage.board.charts.metricNotRecordedTitle', { metric: usageChartMetricName(metric) }) : t('usage.board.charts.needsDataTitle')}
    reason={!calendar ? t('usage.board.charts.needsCalendarReason') : isMeasureUnrecorded(calendar.coverage, metric)
      ? t('usage.board.charts.metricNotRecordedHint') : t('usage.board.charts.metricNotByHourReason', { metric: usageChartMetricName(metric) })} />;
  const window = (from: number, to: number) => `${usageChartClock(from)}–${usageChartClock(to)}`;
  return <View style={{ gap: 12 }} testID={`${props.testID}.daylight`}>
    <UsageDaylight theme={host.theme} paint={host.paint} model={model} label={t('usage.board.charts.daylightA11y', { metric: usageChartMetricName(metric) })} testID={`${props.testID}.daylightChart`}
      labels={{ clock: usageChartClock,
        night: (from, to, share) => share === null ? t('usage.board.charts.nightWindow', { window: window(from, to) }) : t('usage.board.charts.nightWindowShare', { window: window(from, to), share: usageChartPercent(share) }),
        caption: (peak, share) => peak === null ? (share === null ? t('usage.board.charts.daylightCaptionNoPeak') : t('usage.board.charts.daylightCaptionNightOnly', { share: usageChartPercent(share) }))
          : share === null ? t('usage.board.charts.daylightCaption', { hour: usageChartClock(peak) }) : t('usage.board.charts.daylightCaptionNight', { hour: usageChartClock(peak), share: usageChartPercent(share) }),
        values: { ...usageChartValuesLabels(), hourColumn: t('usage.board.charts.hourColumn'), valueColumn: usageChartMetricName(metric), formatValue: (value) => formatUsageChartMetric(metric, value), levelNames: LEVEL_NAMES() } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ Parallel · Lanes | Dial ═════ */

export function UsageDayStyleBody(props: UsageChartStyleBodyProps & Readonly<{ style: 'lanes' | 'dial' }>) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const bucket = React.useMemo(() => calendar ? resolveUsageChartDay(calendar, props.presentation?.day) : null, [calendar, props.presentation?.day]);
  const model = React.useMemo(() => bucket ? projectUsageDayModel(props.slice, bucket) : null, [bucket, props.slice]);
  const agents = React.useMemo(() => (model?.lanes ?? []).flatMap(lane => lane.agentId === null ? [] : [host.agent(lane.agentId)]), [model, host.agent]);
  const ghost = useChartGhost(props.serverId);
  useStyleCaption(t('usage.board.charts.dayTitle'), model ? usageChartDateLabels(props.query).day(model.date) : null);
  if (!model || model.lanes.length === 0) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.dayEmptyTitle')} reason={t('usage.board.charts.dayEmptyReason')}
    ghost={calendar ? ghost('lanes', props.testID) : undefined} />;
  const dates = usageChartDateLabels(props.query);
  return <View style={{ gap: 12 }} testID={`${props.testID}.day`}>
    <UsageDayInAgents theme={host.theme} paint={host.paint} agents={agents} model={model} style={props.style} testID={`${props.testID}.dayChart`}
      label={t('usage.board.charts.dayA11y', { day: dates.day(model.date), count: model.peak.count })}
      labels={{ unknownAgent: usageAgentTitle(''), peakOnlyCaption: t('usage.board.charts.peakOnlyCaption'), clock: usageChartClock, duration: formatUsageDuration, atOnce: t('usage.board.charts.atOnce'), turns: t('usage.board.charts.turns'), agentTime: t('usage.board.charts.agentTime'),
        peak: (count, at) => t('usage.board.charts.peakAt', { count, time: usageChartClock(at) }), peakCount: (count) => t('usage.board.charts.atOnceCount', { count }),
        peakLine: (at, byAgent) => `${usageChartClock(at)} · ${byAgent.map((entry) => `${entry.name} ${entry.count}`).join(', ')}`,
        waiting: t('usage.board.charts.waitingForYou'), caption: { lanes: t('usage.board.charts.lanesCaption'), dial: t('usage.board.charts.dialCaption') },
        values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), agentTimeColumn: t('usage.board.charts.agentTime'), spansColumn: t('usage.board.charts.spansColumn'),
          formatSpan: (from, to) => `${usageChartClock(from)}–${usageChartClock(to)}` } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ Agents: Score, Orbit, Crew, Agent river, Shipped, Constellation ═════ */

export function UsageScoreBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const model = React.useMemo(() => calendar ? projectUsageScoreModel(calendar, props.presentation?.day) : null, [calendar, props.presentation?.day]);
  const agents = React.useMemo(() => (model?.rows ?? []).flatMap((row) => row.agentId === null ? [] : [host.agent(row.agentId)]), [model, host.agent]);
  useWidgetFrameBodyCaption(model ? t('usage.board.charts.scoreSubtitle', { week: usageChartDateLabels(props.query).short(model.weekStart) }) : null);
  if (!model || (calendar && isMeasureUnrecorded(calendar.coverage, 'busy'))) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID}
    title={calendar && isMeasureUnrecorded(calendar.coverage, 'busy') ? t('usage.board.charts.metricNotRecordedTitle', { metric: usageChartMetricName('busy') }) : t('usage.board.charts.needsDataTitle')}
    reason={calendar && isMeasureUnrecorded(calendar.coverage, 'busy') ? t('usage.board.charts.metricNotRecordedHint') : t('usage.board.charts.needsCalendarReason')} />;
  const dates = usageChartDateLabels(props.query);
  const start = Date.parse(`${model.weekStart}T12:00:00Z`);
  const dayDate = (index: number) => new Date(start + index * 86_400_000).toISOString().slice(0, 10);
  return <View style={{ gap: 12 }} testID={`${props.testID}.score`}>
    <UsageScore theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.scoreChart`}
      label={t('usage.board.charts.scoreA11y', { week: dates.short(model.weekStart) })}
      labels={{ day: (index) => dates.weekday(dayDate(index)), clock: usageChartClock,
        key: { light: t('usage.board.charts.scoreLight'), medium: t('usage.board.charts.scoreMedium'), strong: t('usage.board.charts.scoreStrong'),
          presence: t('usage.board.charts.scorePresence'), presenceNote: t('usage.board.charts.scorePresenceNote') },
        unknownAgent: usageAgentTitle(''),
        values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), dayColumn: t('usage.board.charts.dateColumn'), hoursColumn: t('usage.board.charts.busyHoursColumn'),
          formatHours: (minutes) => minutes.flatMap((value, hour) => value ? [`${usageChartClock(hour)} ${formatUsageDuration(value * 60_000)}`] : []).join(', ') } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

function useAgentShares(props: UsageChartStyleBodyProps, metric: UsageChartMetric) {
  const calendar = useCalendar(props);
  return React.useMemo(() => calendar ? projectUsageAgentShares(calendar, metric) : null, [calendar, metric]);
}

export function UsageOrbitBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useWidgetFrameBodyCaption(t('usage.board.charts.shareOf', { metric: usageChartMetricName(resolveUsageChartMetric(props.query.metric, 'tokens')) }));
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const shares = useAgentShares(props, metric);
  const agents = React.useMemo(() => (shares ?? []).flatMap((share) => share.agentId === null ? [] : [host.agent(share.agentId)]), [shares, host.agent]);
  if (!shares || shares.length === 0) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.orbit`}>
    <UsageOrbit theme={host.theme} paint={host.paint} agents={agents} model={shares} renderPlanet={host.renderPlanet} testID={`${props.testID}.orbitChart`}
      label={t('usage.board.charts.orbitA11y', { metric: usageChartMetricName(metric) })}
      labels={usageOrbitLabels()} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageCrewBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputCrew'), usageChartMetricName(resolveUsageChartMetric(props.query.metric, 'tokens')));
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const shares = useAgentShares(props, metric);
  const agents = React.useMemo(() => (shares ?? []).flatMap((share) => share.agentId === null ? [] : [host.agent(share.agentId)]), [shares, host.agent]);
  const calendar = useCalendar(props);
  // How each Agent is measured comes from its own admitted source members, never one global badge.
  const model = React.useMemo(() => {
    const label = (status: string | undefined) => status === 'complete_for_supplied_facts' ? { long: t('usage.board.charts.coverageMeasured'), short: t('usage.board.charts.coverageMeasuredShort') }
      : status === 'partial' ? { long: t('usage.board.charts.coveragePartial'), short: t('usage.board.charts.coveragePartialShort') }
      // Unknown coverage makes no claim on the row; the page's own coverage line says why once.
      : undefined;
    return calendar ? projectUsageAgentShares(calendar, metric, label) : [];
  }, [calendar, metric]);
  if (!shares || shares.length === 0) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  const activeDays = props.slice.howYouWork?.agentCalendar?.days.filter((day) => (day.totals.eventCount ?? 0) > 0).length ?? null;
  return <View style={{ gap: 12 }} testID={`${props.testID}.crew`}>
    <UsageCrew theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.crewChart`} label={t('usage.board.charts.crewA11y')}
      labels={usageCrewLabels(activeDays)} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageRiverStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputRiver'), usageChartMetricName(resolveUsageChartMetric(props.query.metric, 'tokens')));
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const model = React.useMemo(() => calendar ? projectUsageRiverModel(calendar, metric) : null, [calendar, metric]);
  const agents = React.useMemo(() => [...new Set((model?.weeks ?? []).flatMap((week) => week.shares.flatMap(row => row.agentId === null ? [] : [row.agentId])))].map(host.agent), [model, host.agent]);
  if (!model) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.riverEmptyTitle')} reason={t('usage.board.charts.riverEmptyReason')} />;
  const dates = usageChartDateLabels(props.query);
  return <View style={{ gap: 12 }} testID={`${props.testID}.river`}>
    <UsageAgentRiver theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.riverChart`}
      label={t('usage.board.charts.riverA11y', { metric: usageChartMetricName(metric) })}
      labels={{ week: dates.short, inline: (name, share) => `${name} ${usageChartPercent(share)}`, caption: t('usage.board.charts.riverCaption'), unknownAgent: usageAgentTitle(''),
        partialWeek: (start, end) => t('usage.board.charts.partialWeek', { from: dates.short(start), to: dates.short(end) }),
        values: { ...usageChartValuesLabels(), weekColumn: t('usage.board.charts.weekColumn'), totalColumn: usageChartMetricName(metric),
          formatTotal: (total) => formatUsageChartMetric(metric, total), percent: usageChartPercent } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageShippedStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputShipped'));
  const model = React.useMemo(() => projectUsageShippedModel(props.slice), [props.slice]);
  const agents = React.useMemo(() => [...new Set(model?.mode === 'weeks' ? model.weeks.flatMap((week) => week.spines.filter((spine) => spine !== 'mixed')) : [])].map(host.agent),
    [model, host.agent]);
  if (!model || model.total === 0) {
    if (isUsageReadOutstanding(props.slice, ['work'])) return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: ['work'] }} />;
    // "None merged" is only true when pull requests were read; the page header already says why they weren't.
    if (!props.slice.sources.some((source) => source.source === 'work' && ['available', 'partial', 'stale'].includes(source.status)))
      return <UsageBodyInsufficient testID={`${props.testID}.unavailable`} title={t('usage.board.charts.shippedUnavailableTitle')} />;
    return <UsageBodyInsufficient testID={`${props.testID}.empty`} title={t('usage.board.charts.shippedEmptyTitle')} reason={t('usage.board.charts.shippedEmptyReason')} />;
  }
  return <View style={{ gap: 12 }} testID={`${props.testID}.shipped`}>
    <UsageShipped theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.shippedChart`}
      label={t('usage.board.charts.shippedA11y', { count: model.total })}
      labels={usageShippedLabels(props.query, 'agent')} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageConstellationBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useWidgetFrameBodyCaption(t('usage.board.charts.constellationSubtitle'));
  const shares = useAgentShares(props, 'tokens');
  const model = React.useMemo(() => projectUsageConstellationModel(props.slice, shares ?? []), [props.slice, shares]);
  const agents = React.useMemo(() => model.nodes.flatMap((node) => node.agentId === null ? [] : [host.agent(node.agentId)]), [model, host.agent]);
  if (model.nodes.length === 0) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCollaborationReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.constellation`}>
    <UsageConstellation theme={host.theme} paint={host.paint} agents={agents} model={model} renderPlanet={host.renderPlanet} testID={`${props.testID}.constellationChart`}
      label={t('usage.board.charts.constellationA11y')}
      labels={{ kinds: { session: t('usage.board.charts.edgeSession'), run: t('usage.board.charts.edgeRun'), native: t('usage.board.charts.edgeNative') },
        arrowNote: t('usage.board.charts.edgeNote'), unknownStarts: (count) => t('usage.board.charts.unknownStarts', { count }),
        nodesOnly: props.slice.howYouWork?.collaboration ? t('usage.board.charts.nodesOnly') : t('usage.board.charts.collaborationNotRecorded'),
        unknownAgent: usageAgentTitle('') }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ How you work: Your planet, Steering by Agent, Run length ═════ */

export function UsagePlanetBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const intervals = props.slice.howYouWork?.intervals ?? null;
  const model = React.useMemo(() => {
    return calendar ? projectUsagePortraitModel(calendar, intervals?.maxParallel ?? null, Date.now()) : null;
  }, [calendar, intervals]);
  if (!model) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.planet`}>
    <UsagePlanetPortrait theme={host.theme} paint={host.paint} model={model} renderPlanet={host.renderPlanet} testID={`${props.testID}.planetChart`} label={t('usage.board.charts.planetA11y')}
      labels={usagePlanetLabels()} />
  </View>;
}

export function UsageSteeringStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputSteering'));
  const model = React.useMemo(() => projectUsageSteeringModel(props.slice), [props.slice]);
  const agents = React.useMemo(() => (model?.rows ?? []).flatMap((row) => row.agentId ? [host.agent(row.agentId)] : []), [model, host.agent]);
  if (!model || model.rows.length === 0) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.steeringEmptyTitle')} reason={t('usage.board.charts.steeringEmptyReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.steering`}>
    <UsageSteeringTide theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.steeringChart`} label={t('usage.board.charts.steeringA11y')}
      labels={{ clock: usageChartClock, unknownAgent: usageAgentTitle(''), perBusyHourHeader: t('usage.board.charts.steersPerBusyHour'),
        fromPhoneHeader: t('usage.board.charts.fromPhone'), perBusyHourUnit: t('usage.board.charts.steersPerBusyHourUnit'), answers: t('usage.board.charts.answers'),
        rate: (value) => value === null ? '—' : (Math.round(value * 10) / 10).toString(),
        detail: (steers, busyMs) => t('usage.board.charts.steersDetail', { steers: steers ?? '—', busy: busyMs === null ? '—' : formatUsageDuration(busyMs) }),
        count: (value) => value === null ? '—' : String(value), caption: t('usage.board.charts.steeringCaption') }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageRunLengthBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useWidgetFrameBodyCaption(t('usage.board.charts.runSubtitle'));
  const model = React.useMemo(() => projectUsageRunLengthModel(props.slice), [props.slice]);
  const agents = React.useMemo(() => (model?.rows ?? []).flatMap((row) => row.agentId ? [host.agent(row.agentId)] : []), [model, host.agent]);
  const ghost = useChartGhost(props.serverId);
  if (!model) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.runEmptyTitle')} reason={t('usage.board.charts.runEmptyReason')}
    ghost={props.slice.howYouWork ? ghost('runs', props.testID, { ticks: [t('usage.board.charts.tickMinute'), t('usage.board.charts.tickTenMinutes'), t('usage.board.charts.tickHour'), t('usage.board.charts.tickFourHours')] }) : undefined} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.runLength`}>
    <UsageRunLength theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.runLengthChart`} label={t('usage.board.charts.runA11y')}
      labels={{ duration: formatUsageDuration, unknownAgent: usageAgentTitle(''),
        detail: (p90, samples) => t('usage.board.charts.runDetail', { p90: formatUsageDuration(p90), count: samples }),
        ticks: { minute: t('usage.board.charts.tickMinute'), tenMinutes: t('usage.board.charts.tickTenMinutes'), hour: t('usage.board.charts.tickHour'), fourHours: t('usage.board.charts.tickFourHours') },
        caption: model.openCount > 0 ? t('usage.board.charts.runCaptionOpen', { count: model.openCount }) : t('usage.board.charts.runCaption'),
        values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), medianColumn: t('usage.board.charts.median'), p90Column: t('usage.board.charts.p90'),
          samplesColumn: t('usage.board.charts.closedTurns'), formatCount: (count) => count.toLocaleString() } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ Recap · Personal records ═════ */

export function UsageRecordsStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  useStyleCaption(t('usage.board.charts.inputPersonalRecords'));
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const facts = React.useMemo(() => projectUsageRecordFacts(props.slice, metric, Date.now()), [props.slice, metric]);
  if (!facts) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  const dates = usageChartDateLabels(props.query);
  const agents = new Set((props.slice.howYouWork?.agentCalendar?.days ?? []).flatMap((day) => day.agents.flatMap((entry) => entry.agentId ? [entry.agentId] : [])));
  const records = [
    facts.longestStreak ? { id: 'streak', title: t('usage.board.charts.recordStreak'), value: t('usage.board.charts.daysCount', { count: facts.longestStreak.days }),
      detail: facts.longestStreak.ongoing ? t('usage.board.charts.recordRangeOngoing', { from: dates.short(facts.longestStreak.startDate), to: dates.short(facts.longestStreak.endDate) })
        : t('usage.board.charts.recordRange', { from: dates.short(facts.longestStreak.startDate), to: dates.short(facts.longestStreak.endDate) }) } : null,
    facts.busiestDay ? { id: 'busiest', title: t('usage.board.charts.recordBusiestDay'), value: formatUsageChartMetric(metric, facts.busiestDay.value),
      detail: `${usageChartMetricName(metric)} · ${dates.day(facts.busiestDay.date)}` } : null,
    facts.peakParallel ? { id: 'peak', title: t('usage.board.charts.recordPeak'), value: t('usage.board.charts.turnsCount', { count: facts.peakParallel.count }), detail: dates.day(facts.peakParallel.date) } : null,
    facts.longestClosedTurn ? { id: 'turn', title: t('usage.board.charts.recordLongestTurn'), value: formatUsageDuration(facts.longestClosedTurn.ms),
      detail: facts.longestClosedTurn.agentId ? host.agent(facts.longestClosedTurn.agentId).name : usageAgentTitle('') } : null,
    facts.mostAgents ? { id: 'agents', title: t('usage.board.charts.recordMostAgents'), value: t('usage.board.charts.countOf', { count: facts.mostAgents.count, total: agents.size }),
      detail: dates.day(facts.mostAgents.date) } : null,
  ].filter((record): record is NonNullable<typeof record> => record !== null);
  if (records.length === 0) return <UsageChartPending slice={props.slice} onRetry={props.model.refresh} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.records`}>
    <UsagePersonalRecords theme={host.theme} paint={host.paint} model={records} label={t('usage.board.charts.recordsA11y')} caption={t('usage.board.charts.recordsCaption')} testID={`${props.testID}.recordsList`} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}
