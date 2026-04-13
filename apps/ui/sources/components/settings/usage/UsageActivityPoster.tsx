import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ChartTooltip, resolveHeatmapColor } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type {
    UsageAnalyticsActivityViewModel,
    UsageFilterState,
} from '@/sync/api/account/usageAnalytics';
import { formatUsageHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const styles = StyleSheet.create((theme) => ({
    poster: {
        gap: 22,
        paddingHorizontal: 16,
        paddingTop: 2,
        paddingBottom: 6,
    },
    header: {
        gap: 6,
    },
    eyebrow: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: -0.08,
        textTransform: 'uppercase',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 28,
        lineHeight: 34,
        letterSpacing: -0.6,
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        maxWidth: 560,
    },
    tracksStack: {
        gap: 12,
    },
    track: {
        gap: 10,
        minWidth: 0,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingVertical: 14,
        backgroundColor: theme.colors.surfaceHigh,
    },
    trackRow: {
        width: '100%',
    },
    trackHeader: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
    },
    trackLabel: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        letterSpacing: -0.04,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
    },
    trackValue: {
        ...Typography.default('semiBold'),
        fontSize: 32,
        lineHeight: 36,
        letterSpacing: -0.6,
        color: theme.colors.text,
        flexShrink: 1,
        textAlign: 'right',
    },
    bucketRow: {
        flexDirection: 'row',
        gap: 8,
        alignItems: 'stretch',
    },
    bucketRowCompact: {
        flexWrap: 'nowrap',
    },
    bucket: {
        flex: 1,
        minWidth: 0,
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 10,
        justifyContent: 'space-between',
        backgroundColor: theme.colors.groupped.background,
        minHeight: 74,
    },
    bucketCompact: {
        minHeight: 64,
        paddingHorizontal: 7,
        paddingVertical: 8,
    },
    bucketText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
    bucketMetric: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.textSecondary,
    },
}));

function buildMonthBuckets(activity: UsageAnalyticsActivityViewModel): number[] {
    const counts = Array.from({ length: 12 }, () => 0);
    for (const entry of activity.calendarDays) {
        const parsed = new Date(`${entry.date}T00:00:00.000Z`);
        if (Number.isNaN(parsed.getTime())) continue;
        counts[parsed.getUTCMonth()] += entry.eventCount;
    }
    return counts;
}

function buildWeekdayBuckets(activity: UsageAnalyticsActivityViewModel): number[] {
    const counts = Array.from({ length: 7 }, () => 0);
    for (const entry of activity.weekdayHourBuckets) {
        counts[entry.weekday] += entry.eventCount;
    }
    return counts;
}

function buildHourBuckets(activity: UsageAnalyticsActivityViewModel): number[] {
    const counts = Array.from({ length: 12 }, () => 0);
    for (const entry of activity.weekdayHourBuckets) {
        counts[Math.max(0, Math.min(11, Math.floor(entry.hour / 2)))] += entry.eventCount;
    }
    return counts;
}

function resolvePeakIndex(values: readonly number[]): number | null {
    let peakIndex: number | null = null;
    let peakValue = 0;

    values.forEach((value, index) => {
        if (!Number.isFinite(value) || value <= peakValue) {
            return;
        }
        peakValue = value;
        peakIndex = index;
    });

    return peakIndex;
}

function formatMonthLabel(index: number): string {
    return new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(Date.UTC(2026, index, 1)));
}

function formatWeekdayLabel(index: number): string {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(Date.UTC(2026, 0, 4 + index)));
}

function formatHourBucketLabel(index: number): string {
    const startHour = index * 2;
    const endHour = (startHour + 2) % 24;
    return `${formatUsageHourLabel(startHour)}\u2009–\u2009${formatUsageHourLabel(endHour)}`;
}

export function UsageActivityPoster(props: Readonly<{
    activity: UsageAnalyticsActivityViewModel;
    period?: UsageFilterState['period'];
}>): React.ReactElement {
    const { activity, period } = props;
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const monthBuckets = React.useMemo(() => buildMonthBuckets(activity), [activity]);
    const weekdayBuckets = React.useMemo(() => buildWeekdayBuckets(activity), [activity]);
    const hourBuckets = React.useMemo(() => buildHourBuckets(activity), [activity]);
    const peakMonthIndex = React.useMemo(() => resolvePeakIndex(monthBuckets), [monthBuckets]);
    const peakWeekdayIndex = React.useMemo(() => resolvePeakIndex(weekdayBuckets), [weekdayBuckets]);
    const peakHourIndex = React.useMemo(() => resolvePeakIndex(hourBuckets), [hourBuckets]);
    const selectedPeriodLabel = t(getUsagePeriodDefinition(period ?? '30days').translationKey);

    const useCompactScroller = width <= 0 || width < 820;

    function renderBucketRow(params: Readonly<{
        labels: readonly string[];
        counts: readonly number[];
        accentColor: string;
        compact?: boolean;
        tooltipValueFormatter?: (count: number) => string;
    }>) {
        const row = (
            <View style={[styles.bucketRow, useCompactScroller ? styles.bucketRowCompact : null]}>
                {params.labels.map((label, index) => {
                    const count = params.counts[index] ?? 0;
                    const backgroundColor = resolveHeatmapColor({
                        value: count,
                        values: params.counts,
                        baseColor: params.accentColor,
                        emptyColor: theme.colors.groupped.background,
                    });
                    const textColor = count > 0 ? theme.colors.surface : undefined;
                    return (
                        <ChartTooltip
                            key={label}
                            triggerTestID={`usage-activity-poster-${label}-${index}`}
                            title={label}
                            value={params.tooltipValueFormatter ? params.tooltipValueFormatter(count) : count.toLocaleString()}
                            accentColor={params.accentColor}
                            disabled={count <= 0}
                        >
                            <View
                                style={[
                                    styles.bucket,
                                    params.compact ? styles.bucketCompact : null,
                                    useCompactScroller ? { width: params.compact ? 72 : 88, flex: 0 } : null,
                                    { backgroundColor },
                                ]}
                            >
                                <Text style={[styles.bucketText, textColor ? { color: textColor } : null]}>{label}</Text>
                                <Text style={[styles.bucketMetric, textColor ? { color: textColor, opacity: 0.92 } : null]}>
                                    {count > 0 ? count.toLocaleString() : ' '}
                                </Text>
                            </View>
                        </ChartTooltip>
                    );
                })}
            </View>
        );

        if (!useCompactScroller) {
            return row;
        }

        return (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {row}
            </ScrollView>
        );
    }

    return (
        <View style={styles.poster}>
            <View style={styles.header}>
                <Text style={styles.eyebrow}>{t('usage.activity')}</Text>
                <Text style={styles.title}>{t('usage.activityCalendarSubtitle')}</Text>
                <Text style={styles.subtitle}>{selectedPeriodLabel}</Text>
            </View>

            <View style={styles.tracksStack}>
                <View testID="usage-activity-track-row-months" style={styles.trackRow}>
                <View testID="usage-activity-track-months" style={styles.track}>
                    <View style={styles.trackHeader}>
                        <Text style={styles.trackLabel}>{t('usage.mostActiveMonths')}</Text>
                        <Text numberOfLines={1} adjustsFontSizeToFit style={styles.trackValue}>
                            {peakMonthIndex == null ? '—' : formatMonthLabel(peakMonthIndex)}
                        </Text>
                    </View>
                    {renderBucketRow({
                        labels: MONTH_LABELS,
                        counts: monthBuckets,
                        accentColor: theme.colors.accent.orange,
                        compact: true,
                        tooltipValueFormatter: (count) => `${count.toLocaleString()} ${t('usage.events')}`,
                    })}
                </View>
                </View>

                <View testID="usage-activity-track-row-weekdays" style={styles.trackRow}>
                <View testID="usage-activity-track-weekdays" style={styles.track}>
                    <View style={styles.trackHeader}>
                        <Text style={styles.trackLabel}>{t('usage.mostActiveWeekdays')}</Text>
                        <Text numberOfLines={1} adjustsFontSizeToFit style={styles.trackValue}>
                            {peakWeekdayIndex == null ? '—' : formatWeekdayLabel(peakWeekdayIndex)}
                        </Text>
                    </View>
                    {renderBucketRow({
                        labels: WEEKDAY_LABELS,
                        counts: weekdayBuckets,
                        accentColor: theme.colors.accent.orange,
                        tooltipValueFormatter: (count) => `${count.toLocaleString()} ${t('usage.events')}`,
                    })}
                </View>
                </View>

                <View testID="usage-activity-track-row-hours" style={styles.trackRow}>
                <View testID="usage-activity-track-hours" style={styles.track}>
                    <View style={styles.trackHeader}>
                        <Text style={styles.trackLabel}>{t('usage.mostActiveHours')}</Text>
                        <Text numberOfLines={1} adjustsFontSizeToFit style={styles.trackValue}>
                            {peakHourIndex == null ? '—' : formatHourBucketLabel(peakHourIndex)}
                        </Text>
                    </View>
                    {renderBucketRow({
                        labels: hourBuckets.map((_, index) => formatHourBucketLabel(index)),
                        counts: hourBuckets,
                        accentColor: theme.colors.accent.green,
                        compact: true,
                        tooltipValueFormatter: (count) => `${count.toLocaleString()} ${t('usage.events')}`,
                    })}
                </View>
                </View>
            </View>
        </View>
    );
}
