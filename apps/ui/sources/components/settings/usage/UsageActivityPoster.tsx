import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type {
    UsageAnalyticsActivityViewModel,
    UsageAnalyticsInsightsViewModel,
} from '@/sync/api/account/usageAnalytics';
import { formatUsageHourLabel } from '@/sync/api/account/formatUsageRhythmLabel';

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
    track: {
        gap: 10,
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
    bucketHot: {
        backgroundColor: theme.colors.accent.orange,
    },
    bucketWarm: {
        backgroundColor: theme.colors.accent.green,
    },
    bucketText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
    bucketTextHot: {
        color: theme.colors.surface,
    },
    bucketMetric: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.textSecondary,
    },
    bucketMetricHot: {
        color: theme.colors.surface,
        opacity: 0.9,
    },
}));

function resolveMonthIndex(insights: UsageAnalyticsInsightsViewModel): number | null {
    const key = insights.busiestMonth?.key?.trim();
    if (key) {
        const parsed = new Date(`${key}-01T00:00:00.000Z`);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.getUTCMonth();
        }
    }

    const label = insights.busiestMonth?.label?.trim();
    if (!label) return null;
    const match = MONTH_LABELS.findIndex((month) => label.toLowerCase().startsWith(month.toLowerCase()));
    return match >= 0 ? match : null;
}

function resolveWeekdayIndex(activity: UsageAnalyticsActivityViewModel, insights: UsageAnalyticsInsightsViewModel): number | null {
    const key = insights.busiestDay?.key?.trim();
    if (key) {
        const parsed = new Date(`${key}T00:00:00.000Z`);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.getUTCDay();
        }
    }

    const label = insights.busiestDay?.label?.trim();
    if (label) {
        const match = WEEKDAY_LABELS.findIndex((weekday) => label.toLowerCase().startsWith(weekday.toLowerCase()));
        if (match >= 0) {
            return match;
        }
    }

    const topBucket = [...activity.weekdayHourBuckets].sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;
    return topBucket?.weekday ?? null;
}

function resolveHourBucketIndex(activity: UsageAnalyticsActivityViewModel, insights: UsageAnalyticsInsightsViewModel): number | null {
    const rawKey = insights.busiestHour?.key?.trim();
    if (rawKey && /^\d+$/.test(rawKey)) {
        return Math.max(0, Math.min(11, Math.floor(Number(rawKey) / 2)));
    }

    const topBucket = [...activity.weekdayHourBuckets].sort((left, right) => right.eventCount - left.eventCount)[0] ?? null;
    if (topBucket) {
        return Math.max(0, Math.min(11, Math.floor(topBucket.hour / 2)));
    }

    return null;
}

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

export function UsageActivityPoster(props: Readonly<{
    activity: UsageAnalyticsActivityViewModel;
    insights: UsageAnalyticsInsightsViewModel;
}>): React.ReactElement {
    const { activity, insights } = props;
    const { width } = useWindowDimensions();
    const monthBuckets = React.useMemo(() => buildMonthBuckets(activity), [activity]);
    const weekdayBuckets = React.useMemo(() => buildWeekdayBuckets(activity), [activity]);
    const hourBuckets = React.useMemo(() => buildHourBuckets(activity), [activity]);

    const busiestMonthIndex = resolveMonthIndex(insights);
    const busiestWeekdayIndex = resolveWeekdayIndex(activity, insights);
    const busiestHourBucketIndex = resolveHourBucketIndex(activity, insights);
    const useCompactScroller = width < 820;

    function renderBucketRow(params: Readonly<{
        labels: readonly string[];
        counts: readonly number[];
        hotIndex: number | null;
        hotTone: 'hot' | 'warm';
        compact?: boolean;
    }>) {
        const row = (
            <View style={[styles.bucketRow, useCompactScroller ? styles.bucketRowCompact : null]}>
                {params.labels.map((label, index) => {
                    const isHot = params.hotIndex === index;
                    return (
                        <View
                            key={label}
                            style={[
                                styles.bucket,
                                params.compact ? styles.bucketCompact : null,
                                isHot
                                    ? (params.hotTone === 'warm' ? styles.bucketWarm : styles.bucketHot)
                                    : null,
                                useCompactScroller ? { width: params.compact ? 72 : 88, flex: 0 } : null,
                            ]}
                        >
                            <Text style={[styles.bucketText, isHot ? styles.bucketTextHot : null]}>{label}</Text>
                            <Text style={[styles.bucketMetric, isHot ? styles.bucketMetricHot : null]}>
                                {params.counts[index] > 0 ? params.counts[index].toLocaleString() : ' '}
                            </Text>
                        </View>
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
                <Text style={styles.subtitle}>{t('usage.summary.thisWeekSubtitle')}</Text>
            </View>

            <View style={styles.track}>
                <View style={styles.trackHeader}>
                    <Text style={styles.trackLabel}>{t('usage.lastYear')}</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit style={styles.trackValue}>
                        {insights.busiestMonth?.label ?? '—'}
                    </Text>
                </View>
                {renderBucketRow({
                    labels: MONTH_LABELS,
                    counts: monthBuckets,
                    hotIndex: busiestMonthIndex,
                    hotTone: 'hot',
                    compact: true,
                })}
            </View>

            <View style={styles.track}>
                <View style={styles.trackHeader}>
                    <Text style={styles.trackLabel}>{t('usage.activeDays')}</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit style={styles.trackValue}>
                        {insights.busiestDay?.label ?? '—'}
                    </Text>
                </View>
                {renderBucketRow({
                    labels: WEEKDAY_LABELS,
                    counts: weekdayBuckets,
                    hotIndex: busiestWeekdayIndex,
                    hotTone: 'hot',
                })}
            </View>

            <View style={styles.track}>
                <View style={styles.trackHeader}>
                    <Text style={styles.trackLabel}>{t('usage.busiestWindow')}</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit style={styles.trackValue}>
                        {insights.busiestHour?.label ?? '—'}
                    </Text>
                </View>
                {renderBucketRow({
                    labels: hourBuckets.map((count, index) => {
                        const startHour = index * 2;
                        const endHour = (startHour + 2) % 24;
                        return `${formatUsageHourLabel(startHour)}\u2009–\u2009${formatUsageHourLabel(endHour)}`;
                    }),
                    counts: hourBuckets,
                    hotIndex: busiestHourBucketIndex,
                    hotTone: 'warm',
                    compact: true,
                })}
            </View>
        </View>
    );
}
