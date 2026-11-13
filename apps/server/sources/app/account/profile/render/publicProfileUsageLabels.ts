import type { HappierPublicProfileUsageLabels } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PUBLIC_PROFILE_FIELD_COPY_EN as fields, PUBLIC_PROFILE_PAGE_COPY_EN as page,
    PUBLIC_USAGE_CHART_COPY_EN as charts, PUBLIC_USAGE_PLANET_COPY_EN as planet,
    PUBLIC_USAGE_ORIGINAL_COPY_EN as original } from '@happier-dev/protocol/account/publicProfilePublication';
import { resolveUsageCalendarDateStart, resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import { formatTokenCount, formatTokenCountLong, formatUsageCalendarDate, formatUsageChartClock,
    formatUsageDuration, formatUsageSharePercent } from '@happier-dev/protocol/usage/usageFormatting';
import { readBuiltinUsagePublicPresentationDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { PUBLIC_PROFILE_ASSET_LABELS, PUBLIC_PROFILE_LOCALE } from './publicProfileLabels';

/** Anonymous host wording for the shared bodies; only the already public view supplies its calendar. */
export function publicProfileUsageLabels(view: PublicProfileViewV1): HappierPublicProfileUsageLabels {
    const count = (value: number) => formatTokenCountLong(value, PUBLIC_PROFILE_LOCALE);
    const days = (value: number) => charts.daysCount({ count: count(value) });
    const duration = (ms: number) => formatUsageDuration(ms, {
        seconds: seconds => `${count(seconds)} s`, minutes: minutes => `${count(minutes)} min`,
        hours: (hours, minutes) => `${count(hours)} h ${count(minutes)} min`,
    });
    const date = (value: string, options: Intl.DateTimeFormatOptions) => formatUsageCalendarDate(
        resolveUsageCalendarDateStart(value, view.snapshot.period.timeZoneOffsetMinutes),
        view.snapshot.period.timeZoneOffsetMinutes, options, PUBLIC_PROFILE_LOCALE);
    const shortDate = (value: string) => date(value, { day: 'numeric', month: 'short' });
    const weekday = (index: number) => formatUsageCalendarDate(Date.UTC(2024, 0, 1 + index), 0,
        { weekday: 'short' }, PUBLIC_PROFILE_LOCALE);
    const weekdays = [weekday(0), weekday(1), weekday(2), weekday(3), weekday(4), weekday(5), weekday(6)] as const;
    const initials = planet.weekdayInitials.split(',');
    const levelNames = [charts.noActivity, charts.levelQuiet, charts.levelSteady, charts.levelBusy, charts.levelBusiest];
    const levelName = (value: number) => levelNames[value] ?? charts.notRecorded;
    const levels = { quiet: charts.levelQuiet, steady: charts.levelSteady, busy: charts.levelBusy, busiest: charts.levelBusiest };
    const values = { show: charts.showValues, hide: charts.hideValues };
    const recordTitles = { activeDays: fields.activeDays, currentStreakDays: fields.currentStreak, bestStreakDays: fields.bestStreak,
        peakParallel: charts.recordPeak, longestTurnMs: charts.recordLongestTurn };
    const recordPeriod = PUBLIC_PROFILE_ASSET_LABELS.period(view.snapshot.period);
    const labels = {
        chartLabel: widgetId => readBuiltinUsagePublicPresentationDescriptorV1(widgetId)?.title ?? 'Public activity',
        unavailable: page.blockUnavailable,
        original: {
            metrics: { tokens: fields.tokens, activeDays: fields.activeDays, agentTimeMs: original.page.agentTime, mergedPrs: fields.mergedPrs,
                currentStreakDays: fields.currentStreak, bestStreakDays: fields.bestStreak, peakParallel: fields.peakParallel },
            // As the owner preview writes them: compact tokens, a duration, a plain count.
            formatMetric: (kind, value) => kind === 'agentTimeMs' ? duration(value) : kind === 'tokens' ? formatTokenCount(value) : count(value),
            activityLevel: page.activityLevel, level: levelName, date: shortDate, weekdays, clock: formatUsageChartClock,
            showValues: values.show, hideValues: values.hide,
            agentMix: fields.agentMix, sourceSplit: fields.sourceSplit, percent: formatUsageSharePercent,
            source: execution => ({ happier: original.page.executionHappier, outside: original.page.executionOutside, unknown: original.page.executionUnknown })[execution],
            coverage: { title: original.widgets.usage_source_coverage, columns: [original.widgets.usage_sources, original.widgets.usage_source_coverage],
                status: status => ({ complete_for_supplied_facts: original.sources.coverageAvailable, partial: original.page.factIncomplete,
                    unknown: original.sources.coverageUnknown, unavailable: 'Unavailable' })[status],
                method: method => ({ runtime: original.page.sourceKindMeasured, logs: original.page.sourceKindFromLogs,
                    context_only: charts.coverageContextOnlyShort, mixed: original.widgets.usage_sources, unknown: original.sources.coverageUnknown })[method] },
            footprint: { title: original.howYouWork.footprintInsufficientTitle, reason: original.howYouWork.footprintInsufficientReason,
                noEstimate: original.howYouWork.footprintNoEstimate, accounted: original.howYouWork.footprintAccounted, tokensUnit: 'tokens',
                proxy: original.howYouWork.footprintProxy, proxyDetail: original.howYouWork.footprintProxyDetail,
                methodTitle: original.howYouWork.footprintMethodTitle, methodBody: original.howYouWork.footprintMethodBody },
            period: recordPeriod,
        },
        sky: {
            formatValue: levelName,
            month: value => date(value, { month: 'short' }),
            day: value => date(value, { weekday: 'short', day: 'numeric', month: 'short' }),
            levels,
            streakBestOngoing: days => charts.streakBestOngoing({ count: count(days) }),
            streakBest: value => charts.streakBest({ count: value }), streakNow: value => charts.streakNow({ count: value }),
            streakShort: (days, best) => (best ? charts.streakShortBest : charts.streakShort)({ count: count(days) }),
            key: { tie: charts.tie, notAttributed: charts.notAttributed, noActivity: charts.noActivity, notRecorded: charts.notRecorded,
                quieter: charts.quieter, busier: charts.busier },
            caption: charts.skyCaptionIntensity,
            values: { ...values, dateColumn: charts.dateColumn, valueColumn: page.activityLevel, leaderColumn: charts.leaderColumn,
                noActivity: charts.noActivity, notRecorded: charts.notRecorded, tie: charts.tie, notAttributed: charts.notAttributed },
        },
        weekTide: {
            weekdays, clock: formatUsageChartClock,
            peak: (day, hour, value) => `${weekdays[day] ?? ''} ${formatUsageChartClock(hour)} · ${levelName(value)}`,
            values: { ...values, weekdayColumn: charts.weekdayColumn, formatValue: levelName, levelNames },
        },
        daylight: {
            clock: formatUsageChartClock,
            night: (from, to, share) => share === null ? charts.nightWindow({ window: `${formatUsageChartClock(from)}–${formatUsageChartClock(to)}` })
                : charts.nightWindowShare({ window: `${formatUsageChartClock(from)}–${formatUsageChartClock(to)}`, share: formatUsageSharePercent(share) }),
            // The public punch may be absent even when the night share is known; never invent a peak hour.
            caption: () => charts.daylightCaptionNoPeak,
            values: { ...values, hourColumn: charts.hourColumn, valueColumn: page.activityLevel, formatValue: levelName, levelNames },
        },
        parallel: {
            unknownAgent: charts.unknownAgent,
            peakOnlyCaption: charts.peakOnlyCaption,
            clock: formatUsageChartClock, duration, atOnce: charts.atOnce, turns: charts.turns, agentTime: charts.agentTime,
            peak: (total, atHour) => `${charts.atOnceCount({ count: count(total) })} · ${formatUsageChartClock(atHour)}`,
            peakCount: total => charts.atOnceCount({ count: count(total) }),
            peakLine: (atHour, byAgent) => `${formatUsageChartClock(atHour)} · ${byAgent.map(entry => `${entry.name} ${count(entry.count)}`).join(', ')}`,
            waiting: charts.waitingForYou,
            caption: {
                lanes: charts.lanesCaption,
                dial: charts.dialCaption,
            },
            values: { ...values, agentColumn: charts.agentColumn, agentTimeColumn: original.page.agentTime, spansColumn: charts.spansColumn,
                formatSpan: (from, to) => `${formatUsageChartClock(from)}–${formatUsageChartClock(to)}` },
        },
        orbit: { percent: formatUsageSharePercent, unknown: names => charts.shareUnknown({ names }), unknownAgent: charts.unknownAgent,
            values: { ...values, agentColumn: charts.agentColumn, shareColumn: planet.shareColumn } },
        crew: { percent: formatUsageSharePercent, days, unknownAgent: charts.unknownAgent },
        river: {
            week: shortDate, inline: (name, share) => `${name} ${formatUsageSharePercent(share)}`,
            caption: "Each week's shared agent mix. Equal widths do not imply weekly totals.", unknownAgent: charts.unknownAgent,
            partialWeek: (start, end) => planet.partialWeek({ from: shortDate(start), to: shortDate(end) }),
            values: { ...values, weekColumn: planet.weekColumn, totalColumn: 'Total not shared', formatTotal: () => '—', percent: formatUsageSharePercent },
        },
        shipped: { week: shortDate, noDate: charts.noDate, countLine: total => charts.shippedCount({ count: count(total) }),
            mixed: charts.mixed, noMergeDate: charts.noMergeDate, colourBy: 'accent',
            values: { ...values, weekColumn: planet.weekColumn, countColumn: planet.countColumn } },
        constellation: {
            kinds: { session: charts.edgeSession, run: charts.edgeRun, native: charts.edgeNative },
            arrowNote: charts.edgeNote,
            unknownStarts: total => charts.unknownStarts({ count: count(total) }),
            nodesOnly: 'Collaboration details are not shared; each planet is an agent sized by its share.', unknownAgent: charts.unknownAgent,
            values: { ...values, agentColumn: charts.agentColumn, shareColumn: planet.shareColumn, kindColumn: 'Kind', countColumn: planet.countColumn },
        },
        planet: {
            rows: { light: charts.planetLight, halo: charts.planetHalo, trail: charts.planetTrail },
            activeDays: (active, of) => charts.daysOf({ count: count(active), total: count(of) }), peak: total => charts.upToAtOnce({ count: count(total) }),
            streak: days => charts.dayStreak({ count: count(days) }), notShared: charts.notRecorded,
            lightNote: charts.planetLightNote, lightRest: charts.planetLightRest,
            haloNote: charts.planetHaloNote, haloRest: charts.planetHaloRest,
            trailNote: best => best === null ? charts.planetTrailNoteNoBest
                : charts.planetTrailNote({ count: best }), trailRest: charts.planetTrailRest,
        },
        calendar: {
            month: value => date(value, { month: 'short' }), day: value => date(value, { weekday: 'short', day: 'numeric', month: 'short' }), short: shortDate,
            weekdayInitials: [initials[0] ?? '', initials[1] ?? '', initials[2] ?? '', initials[3] ?? '', initials[4] ?? '', initials[5] ?? '', initials[6] ?? ''],
            levels, noActivity: charts.noActivity, notRecorded: charts.notRecorded,
            quieter: charts.quieter, busier: charts.busier, best: value => planet.streakBestDays({ count: value }), now: value => planet.streakNowDays({ count: value }),
            ongoingBest: value => planet.streakOngoingBest({ count: value }),
            lit: (active, days) => planet.daysLit({ count: count(active), total: count(days) }), noRuns: planet.noStreakRings,
            values: { ...values, dateColumn: charts.dateColumn, levelColumn: planet.levelColumn, weekColumn: planet.weekColumn, activeDaysColumn: planet.activeDaysColumn },
        },
        moons: {
            percent: formatUsageSharePercent, days: (active, of) => charts.daysOf({ count: count(active), total: count(of) }), unknownAgent: charts.unknownAgent,
            caption: daysShared => daysShared ? planet.moonsCaptionDays : planet.moonsCaption,
            values: { ...values, agentColumn: charts.agentColumn, shareColumn: planet.shareColumn, daysColumn: planet.daysColumn },
        },
        machines: {
            kind: (kind, total) => `${kind === 'unknown' ? planet.machineKindUnknown : kind}${total > 1 ? ` ×${count(total)}` : ''}`, percent: formatUsageSharePercent,
            unavailable: planet.machinesUnavailable, empty: planet.machinesEmpty,
            values: { ...values, kindColumn: planet.kindColumn, countColumn: planet.countColumn, shareColumn: planet.shareColumn },
        },
        projects: { empty: planet.projectsEmpty },
        atmosphere: {
            week: startMs => shortDate(resolveUsageCalendarInstant(startMs, view.snapshot.period.timeZoneOffsetMinutes).date),
            peak: total => charts.upToAtOnce({ count: count(total) }), firstWeek: planet.atmosphereFirstWeek,
            caption: peak => peak === null ? planet.atmosphereCaption : planet.atmosphereCaptionPeak({ count: count(peak) }),
            values: { ...values, weekColumn: planet.weekColumn, peakColumn: planet.peakColumn, notRecorded: charts.notRecorded },
        },
        runLength: {
            duration, unknownAgent: charts.unknownAgent, detail: (p90, samples) => charts.runDetail({ p90: duration(p90), count: count(samples) }),
            ticks: { minute: charts.tickMinute, tenMinutes: charts.tickTenMinutes, hour: charts.tickHour, fourHours: charts.tickFourHours },
            caption: charts.runCaption,
            values: { ...values, agentColumn: charts.agentColumn, medianColumn: charts.median, p90Column: charts.p90,
                samplesColumn: 'Observations', formatCount: count },
        },
        records: {
            format: (kind, value) => ({ title: recordTitles[kind], detail: `Within the supplied period · ${recordPeriod}`,
                value: kind === 'longestTurnMs' ? duration(value) : kind === 'peakParallel' ? `${count(value)} at once` : days(value) }),
            caption: 'Shared records within the period shown.',
        },
    } satisfies Required<HappierPublicProfileUsageLabels>;
    return labels;
}
