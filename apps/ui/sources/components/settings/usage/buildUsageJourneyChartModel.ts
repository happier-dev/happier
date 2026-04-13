import type { UsageMetric, UsageAnalyticsTimelineBucket, UsageAnalyticsTimelineLeaderRow } from '@/sync/api/account/usageAnalytics';

export type UsageJourneyChartPoint = Readonly<{
    x: number;
    y: number;
    bucketIndex: number;
    value: number;
}>;

export type UsageJourneyChartSeries = Readonly<{
    key: string;
    label: string;
    points: readonly UsageJourneyChartPoint[];
}>;

export type UsageJourneyChartModel = Readonly<{
    bucketCount: number;
    latestLeaders: readonly UsageAnalyticsTimelineLeaderRow[];
    maxValue: number;
    series: readonly UsageJourneyChartSeries[];
}>;

type BuildUsageJourneyChartModelInput = Readonly<{
    timeline: readonly UsageAnalyticsTimelineBucket[];
    metric: UsageMetric;
    maxLeaders?: number;
    usableWidth?: number;
    xOffset?: number;
    chartTop?: number;
    chartBottom?: number;
}>;

function getLeaderValue(leader: UsageAnalyticsTimelineLeaderRow, metric: UsageMetric): number {
    return metric === 'cost' ? leader.totalCost : leader.totalTokens;
}

function resolveLeaderSeriesLabel(leader: UsageAnalyticsTimelineLeaderRow): string {
    const label = leader.label.trim();
    return label.length > 0 ? label : leader.key;
}

function aggregateBucketLeaders(
    leaders: readonly UsageAnalyticsTimelineLeaderRow[],
): UsageAnalyticsTimelineLeaderRow[] {
    const aggregated = new Map<string, UsageAnalyticsTimelineLeaderRow>();

    for (const leader of leaders) {
        const label = resolveLeaderSeriesLabel(leader);
        const existing = aggregated.get(label);
        if (!existing) {
            aggregated.set(label, {
                ...leader,
                key: label,
                label,
            });
            continue;
        }

        aggregated.set(label, {
            ...existing,
            eventCount: existing.eventCount + leader.eventCount,
            totalTokens: existing.totalTokens + leader.totalTokens,
            totalCost: existing.totalCost + leader.totalCost,
        });
    }

    return Array.from(aggregated.values());
}

export function buildUsageJourneyChartModel(
    input: BuildUsageJourneyChartModelInput,
): UsageJourneyChartModel {
    const {
        timeline,
        metric,
        maxLeaders = 6,
        usableWidth = 644,
        xOffset = 0,
        chartTop = 24,
        chartBottom = 156,
    } = input;

    if (timeline.length === 0) {
        return {
            bucketCount: 0,
            latestLeaders: [],
            maxValue: 1,
            series: [],
        };
    }

    const normalizedBuckets = timeline.map((bucket) => ({
        ...bucket,
        leaders: aggregateBucketLeaders(bucket.leaders),
    }));

    const aggregateByLabel = new Map<string, { label: string; total: number }>();
    for (const bucket of normalizedBuckets) {
        for (const leader of bucket.leaders) {
            const current = aggregateByLabel.get(leader.label) ?? { label: leader.label, total: 0 };
            current.total += getLeaderValue(leader, metric);
            aggregateByLabel.set(leader.label, current);
        }
    }

    const selectedLabels = Array.from(aggregateByLabel.entries())
        .sort((left, right) => {
            if (right[1].total !== left[1].total) {
                return right[1].total - left[1].total;
            }
            return left[1].label.localeCompare(right[1].label);
        })
        .slice(0, maxLeaders)
        .map(([label]) => label);

    const maxValue = Math.max(
        ...normalizedBuckets.flatMap((bucket) =>
            bucket.leaders
                .filter((leader) => selectedLabels.includes(leader.label))
                .map((leader) => getLeaderValue(leader, metric))
        ),
        1,
    );
    const height = chartBottom - chartTop;
    const bucketCount = timeline.length;

    const series: UsageJourneyChartSeries[] = selectedLabels.map((label) => {
        const points: UsageJourneyChartPoint[] = [];

        normalizedBuckets.forEach((bucket, bucketIndex) => {
            const leader = bucket.leaders.find((entry) => entry.label === label);
            if (!leader) {
                return;
            }
            const value = getLeaderValue(leader, metric);
            const ratio = maxValue <= 0 ? 0 : value / maxValue;
            points.push({
                bucketIndex,
                x: xOffset + (bucketCount <= 1 ? usableWidth / 2 : (bucketIndex / (bucketCount - 1)) * usableWidth),
                y: chartBottom - ratio * height,
                value,
            });
        });

        return { key: label, label, points };
    });

    const latestBucket = normalizedBuckets[normalizedBuckets.length - 1];
    const latestLeaders = latestBucket
        ? aggregateBucketLeaders(latestBucket.leaders)
            .filter((leader) => selectedLabels.includes(leader.label))
            .sort((left, right) => getLeaderValue(right, metric) - getLeaderValue(left, metric))
            .slice(0, maxLeaders)
        : [];

    return {
        bucketCount,
        latestLeaders,
        maxValue,
        series,
    };
}
