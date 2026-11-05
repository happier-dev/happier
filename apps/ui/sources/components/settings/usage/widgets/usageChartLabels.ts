import type {
  PublicUsageOriginalLabels, UsageAtmosphereLabels, UsageCalendarLabels, UsageCrewLabels, UsageMachinesLabels, UsageMoonsLabels, UsageOrbitLabels,
  UsagePortraitLabels, UsageProjectsLabels, UsageRingsLabels, UsageShippedLabels, UsageSkyLabels, UsageSurfaceLabels,
} from '@happier-dev/plugin-ui/presentation';
import { resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { t } from '@/text';
import { usageAgentTitle } from '@/sync/domains/usage/usageLabels';
import { usageChartClock, usageChartDateLabels, usageChartPercent, usageChartValuesLabels, usageChartWeekdays } from './usageChartHost';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { formatUsageDuration } from './usageHowYouWorkPresentation';

/** Original shared forms bind the same Usage wording to already admitted public facts. */
export function usagePublicOriginalLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>, period: string): PublicUsageOriginalLabels {
  const dates = usageChartDateLabels(query);
  const levels = [t('usage.board.charts.noActivity'), t('usage.board.charts.levelQuiet'), t('usage.board.charts.levelSteady'),
    t('usage.board.charts.levelBusy'), t('usage.board.charts.levelBusiest')];
  return {
    metrics: {
      tokens: t('publicIdentity.publicData.fields.tokens'), activeDays: t('publicIdentity.publicData.fields.activeDays'),
      agentTimeMs: t('usage.board.page.agentTime'), mergedPrs: t('publicIdentity.publicData.fields.mergedPrs'),
      currentStreakDays: t('publicIdentity.publicData.fields.currentStreak'), bestStreakDays: t('publicIdentity.publicData.fields.bestStreak'),
      peakParallel: t('publicIdentity.publicData.fields.peakParallel'),
    },
    formatMetric: (kind, value) => kind === 'agentTimeMs' ? formatUsageDuration(value) : kind === 'tokens' ? formatTokenCount(value) : value.toLocaleString(),
    activityLevel: t('publicIdentity.page.activityLevel'), level: value => levels[value] ?? t('common.unavailable'),
    date: dates.short, weekdays: usageChartWeekdays(), clock: usageChartClock,
    showValues: t('usage.board.charts.showValues'), hideValues: t('usage.board.charts.hideValues'),
    agentMix: t('publicIdentity.publicData.fields.agentMix'), sourceSplit: t('publicIdentity.publicData.fields.sourceSplit'), percent: usageChartPercent,
    source: execution => execution === 'happier' ? t('usage.board.page.executionHappier') : execution === 'outside'
      ? t('usage.board.page.executionOutside') : t('usage.board.page.executionUnknown'),
    coverage: { title: t('usage.widgets.usage_source_coverage'), columns: [t('usage.widgets.usage_sources'), t('usage.widgets.usage_source_coverage')],
      status: status => status === 'complete_for_supplied_facts' ? t('usage.board.sources.coverageAvailable') : status === 'partial'
        ? t('usage.board.page.factIncomplete') : status === 'unknown' ? t('usage.board.sources.coverageUnknown') : t('common.unavailable'),
      method: method => method === 'runtime' ? t('usage.board.page.sourceKindMeasured') : method === 'logs'
        ? t('usage.board.page.sourceKindFromLogs') : method === 'context_only' ? t('usage.board.charts.coverageContextOnlyShort')
          : method === 'unknown' ? t('usage.board.sources.coverageUnknown') : t('usage.widgets.usage_sources'),
    },
    footprint: { title: t('usage.board.howYouWork.footprintInsufficientTitle'), reason: t('usage.board.howYouWork.footprintInsufficientReason'),
      noEstimate: t('usage.board.howYouWork.footprintNoEstimate'), accounted: t('usage.board.howYouWork.footprintAccounted'), tokensUnit: t('usage.tokens').toLocaleLowerCase(),
      proxy: t('usage.board.howYouWork.footprintProxy'), proxyDetail: t('usage.board.howYouWork.footprintProxyDetail'),
      methodTitle: t('usage.board.howYouWork.footprintMethodTitle'), methodBody: t('usage.board.howYouWork.footprintMethodBody') },
    period,
  };
}

/**
 * The app's wording for the shared chart bodies, built once for every consumer: private Usage
 * widgets and the owner's public profile preview read the same labels.
 */
export function usageSkyLabels(input: Readonly<{
  query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>; metricName: string; formatValue: (value: number) => string;
  colourBy: 'intensity' | 'leadingAgent';
}>): UsageSkyLabels {
  const dates = usageChartDateLabels(input.query);
  return {
    formatValue: input.formatValue, month: dates.month, day: dates.day,
    levels: { quiet: t('usage.board.charts.levelQuiet'), steady: t('usage.board.charts.levelSteady'), busy: t('usage.board.charts.levelBusy'), busiest: t('usage.board.charts.levelBusiest') },
    streakBestOngoing: (days) => t('usage.board.charts.streakBestOngoing', { count: days }),
    streakBest: (days) => t('usage.board.charts.streakBest', { count: days }),
    streakNow: (days) => t('usage.board.charts.streakNow', { count: days }),
    streakShort: (days, best) => best ? t('usage.board.charts.streakShortBest', { count: days }) : t('usage.board.charts.streakShort', { count: days }),
    key: { tie: t('usage.board.charts.tie'), notAttributed: t('usage.board.charts.notAttributed'), noActivity: t('usage.board.charts.noActivity'),
      notRecorded: t('usage.board.charts.notRecorded'), quieter: t('usage.board.charts.quieter'), busier: t('usage.board.charts.busier') },
    caption: (drawn) => input.colourBy === 'leadingAgent' ? t('usage.board.charts.skyCaptionAgent', { metric: input.metricName, ...drawn }) : t('usage.board.charts.skyCaptionIntensity', drawn),
    values: { ...usageChartValuesLabels(), dateColumn: t('usage.board.charts.dateColumn'), valueColumn: input.metricName, leaderColumn: t('usage.board.charts.leaderColumn'),
      noActivity: t('usage.board.charts.noActivity'), notRecorded: t('usage.board.charts.notRecorded'), tie: t('usage.board.charts.tie'), notAttributed: t('usage.board.charts.notAttributed') },
  };
}

export function usageOrbitLabels(): UsageOrbitLabels {
  return { percent: usageChartPercent, unknown: (names) => t('usage.board.charts.shareUnknown', { names }), unknownAgent: usageAgentTitle('') };
}

/** `activeDays` is the period's active-day total when known; Agent days then read "12 of 40". */
export function usageCrewLabels(activeDays: number | null): UsageCrewLabels {
  return { percent: usageChartPercent, unknownAgent: usageAgentTitle(''),
    days: (days) => activeDays === null ? t('usage.board.charts.daysCount', { count: days }) : t('usage.board.charts.daysOf', { count: days, total: activeDays }) };
}

export function usagePlanetLabels(): UsagePortraitLabels {
  return { rows: { light: t('usage.board.charts.planetLight'), halo: t('usage.board.charts.planetHalo'), trail: t('usage.board.charts.planetTrail') },
    activeDays: (active, of) => t('usage.board.charts.daysOf', { count: active, total: of }), peak: (count) => t('usage.board.charts.upToAtOnce', { count }),
    streak: (days) => t('usage.board.charts.dayStreak', { count: days }), notShared: t('usage.board.charts.notRecorded'),
    lightNote: t('usage.board.charts.planetLightNote'), lightRest: t('usage.board.charts.planetLightRest'), haloNote: t('usage.board.charts.planetHaloNote'),
    haloRest: t('usage.board.charts.planetHaloRest'), trailNote: (best) => best === null ? t('usage.board.charts.planetTrailNoteNoBest') : t('usage.board.charts.planetTrailNote', { count: best }),
    trailRest: t('usage.board.charts.planetTrailRest') };
}

export function usageShippedLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>, colourBy: UsageShippedLabels['colourBy']): UsageShippedLabels {
  const dates = usageChartDateLabels(query);
  return { week: dates.short, noDate: t('usage.board.charts.noDate'), countLine: (count) => t('usage.board.charts.shippedCount', { count }),
    mixed: t('usage.board.charts.mixed'), noMergeDate: t('usage.board.charts.noMergeDate'), colourBy };
}

/** Wording shared by the calendar bodies (Ninety planets, Streak thread, Weeks, Around the period, Days on the surface, Rings). */
export function usageCalendarLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>): UsageCalendarLabels {
  const dates = usageChartDateLabels(query);
  const initials = t('usage.board.charts.weekdayInitials').split(',');
  return {
    month: dates.month, day: dates.day, short: dates.short,
    weekdayInitials: [initials[0] ?? '', initials[1] ?? '', initials[2] ?? '', initials[3] ?? '', initials[4] ?? '', initials[5] ?? '', initials[6] ?? ''],
    levels: { quiet: t('usage.board.charts.levelQuiet'), steady: t('usage.board.charts.levelSteady'), busy: t('usage.board.charts.levelBusy'), busiest: t('usage.board.charts.levelBusiest') },
    noActivity: t('usage.board.charts.noActivity'), notRecorded: t('usage.board.charts.notRecorded'),
    quieter: t('usage.board.charts.quieter'), busier: t('usage.board.charts.busier'),
    best: (count) => t('usage.board.charts.streakBestDays', { count }), now: (count) => t('usage.board.charts.streakNowDays', { count }),
    ongoingBest: (count) => t('usage.board.charts.streakOngoingBest', { count }),
    values: { ...usageChartValuesLabels(), dateColumn: t('usage.board.charts.dateColumn'), levelColumn: t('usage.board.charts.levelColumn'),
      weekColumn: t('usage.board.charts.weekColumn'), activeDaysColumn: t('usage.board.charts.activeDaysColumn') },
  };
}

export function usageSurfaceLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>): UsageSurfaceLabels {
  return { ...usageCalendarLabels(query), lit: (count, total) => t('usage.board.charts.daysLit', { count, total }) };
}

export function usageRingsLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>): UsageRingsLabels {
  return { ...usageCalendarLabels(query), noRuns: t('usage.board.charts.noStreakRings') };
}

export function usageMoonsLabels(): UsageMoonsLabels {
  return { percent: usageChartPercent, unknownAgent: usageAgentTitle(''),
    days: (count, total) => t('usage.board.charts.daysOf', { count, total }),
    caption: (daysShared) => daysShared ? t('usage.board.charts.moonsCaptionDays') : t('usage.board.charts.moonsCaption'),
    values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), shareColumn: t('usage.board.charts.shareColumn'),
      daysColumn: t('usage.board.charts.daysColumn') } };
}

export function usageMachinesLabels(): UsageMachinesLabels {
  return { percent: usageChartPercent,
    // The owner has no witnessed kind taxonomy yet; an unnamed kind is said as Unknown, never guessed.
    kind: (kind, count) => `${kind === 'unknown' ? t('usage.board.charts.machineKindUnknown') : kind}${count > 1 ? ` ×${count}` : ''}`,
    unavailable: t('usage.board.charts.machinesUnavailable'), empty: t('usage.board.charts.machinesEmpty'),
    values: { ...usageChartValuesLabels(), kindColumn: t('usage.board.charts.kindColumn'), countColumn: t('usage.board.charts.countColumn'),
      shareColumn: t('usage.board.charts.shareColumn') } };
}

export function usageProjectsLabels(): UsageProjectsLabels {
  return { empty: t('usage.board.charts.projectsEmpty') };
}

export function usageAtmosphereLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>): UsageAtmosphereLabels {
  const dates = usageChartDateLabels(query);
  const offset = query.timeZoneOffsetMinutes ?? 0;
  return { week: (startMs) => dates.short(resolveUsageCalendarInstant(startMs, offset).date), peak: (count) => t('usage.board.charts.upToAtOnce', { count }),
    firstWeek: t('usage.board.charts.atmosphereFirstWeek'),
    caption: (peak) => peak === null ? t('usage.board.charts.atmosphereCaption') : t('usage.board.charts.atmosphereCaptionPeak', { count: peak }),
    values: { ...usageChartValuesLabels(), weekColumn: t('usage.board.charts.weekColumn'), peakColumn: t('usage.board.charts.peakColumn'),
      notRecorded: t('usage.board.charts.notRecorded') } };
}
