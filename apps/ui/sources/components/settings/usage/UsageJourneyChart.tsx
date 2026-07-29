import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';

import { ChartTooltip, HorizontalChartFrame } from '@/components/ui/charts';
import { DrawnLinePath } from '@/components/instrument';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { UsageAnalyticsTimelineBucket, UsageMetric } from '@/sync/api/account/usageAnalytics';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';

import { buildUsageJourneyChartModel } from './buildUsageJourneyChartModel';
import { usageSeriesColor, usageSignatureAccent } from './usageAccent';
import { useEntrancesEnabled } from './sections/EntranceView';

type UsageJourneyChartProps = Readonly<{
    timeline: readonly UsageAnalyticsTimelineBucket[];
    metric: UsageMetric;
    currency?: string;
    testID?: string;
}>;

type RankPoint = Readonly<{
    x: number;
    y: number;
    bucketIndex: number;
}>;

const CHART_HEIGHT = 188;
const CHART_PADDING_TOP = 26;
const CHART_PADDING_BOTTOM = 34;
const CHART_PADDING_X = 18;
const JOURNEY_BUCKET_WIDTH = 56;
const JOURNEY_MIN_WIDTH = 596;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 14,
    },
    chartWrap: {
        overflow: 'hidden',
    },
    chartCanvas: {
        width: '100%',
        height: CHART_HEIGHT,
        position: 'relative',
    },
    pointHitArea: {
        position: 'absolute',
        width: 24,
        height: 24,
        marginLeft: -12,
        marginTop: -12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pointHitTarget: {
        width: 24,
        height: 24,
    },
    latestSummary: {
        gap: 8,
        paddingHorizontal: 2,
    },
    latestLabel: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.secondary,
        textTransform: 'uppercase',
    },
    latestRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    latestPill: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    latestPillDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
    },
    latestPillText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
}));

function buildSegmentPath(points: readonly RankPoint[]): string {
    if (points.length === 0) return '';

    const segments: string[] = [];
    let activeSegment: RankPoint[] = [points[0]];

    for (let index = 1; index < points.length; index += 1) {
        const current = points[index];
        const previous = points[index - 1];
        if (current.bucketIndex === previous.bucketIndex + 1) {
            activeSegment.push(current);
            continue;
        }

        segments.push(`M ${activeSegment[0].x} ${activeSegment[0].y} ${activeSegment.slice(1).map((point) => `L ${point.x} ${point.y}`).join(' ')}`);
        activeSegment = [current];
    }

    segments.push(`M ${activeSegment[0].x} ${activeSegment[0].y} ${activeSegment.slice(1).map((point) => `L ${point.x} ${point.y}`).join(' ')}`);
    return segments.join(' ');
}

function formatBucketLabel(timestampMs: number, bucketCount: number): string {
    const date = new Date(timestampMs);
    return formatWithCachedDateTimeFormatter(date, undefined, bucketCount > 16 ? { month: 'short' } : { month: 'short', day: 'numeric' });
}

function formatMetricValue(value: number, metric: UsageMetric, currency: string): string {
    if (metric === 'cost') {
        return formatUsageCost(value, currency);
    }
    return formatTokenCount(value);
}

export function UsageJourneyChart(props: UsageJourneyChartProps): React.ReactElement | null {
    const { timeline, metric, currency = 'USD', testID } = props;
    // Single guard source (R-L6 F1): no line draw-in replay on a revisit remount.
    const entrancesEnabled = useEntrancesEnabled();
    const { theme } = useUnistyles();

    if (timeline.length === 0) {
        return null;
    }

    // ONE-accent system (D-1): series are ORDERED tonal steps of the single
    // signature accent, never different hues.
    const seriesColorAt = (index: number) => usageSeriesColor(theme, index);
    const accentFallback = usageSignatureAccent(theme);

    const bucketCount = timeline.length;
    const chartWidth = Math.max(JOURNEY_MIN_WIDTH, CHART_PADDING_X * 2 + Math.max(bucketCount, 8) * JOURNEY_BUCKET_WIDTH);
    const usableWidth = chartWidth - CHART_PADDING_X * 2;
    const chartModel = buildUsageJourneyChartModel({
        timeline,
        metric,
        maxLeaders: 6,
        usableWidth,
        xOffset: CHART_PADDING_X,
        chartTop: CHART_PADDING_TOP,
        chartBottom: CHART_HEIGHT - CHART_PADDING_BOTTOM,
    });
    const colorByLabel = new Map(chartModel.series.map((series, index) => [series.label, seriesColorAt(index)]));

    return (
        <View testID={testID} style={styles.container}>
            <HorizontalChartFrame contentWidth={chartWidth} style={styles.chartWrap}>
                <View style={[styles.chartCanvas, { width: chartWidth }]}>
                    <Svg
                        width={chartWidth}
                        height={CHART_HEIGHT}
                        viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`}
                    >
                        {timeline.map((bucket, bucketIndex) => {
                            const x = CHART_PADDING_X + (bucketCount <= 1 ? usableWidth / 2 : (bucketIndex / (bucketCount - 1)) * usableWidth);
                            return (
                                <Line
                                    key={`guide-${bucket.bucketStartMs}`}
                                    x1={x}
                                    y1={CHART_PADDING_TOP - 10}
                                    x2={x}
                                    y2={CHART_HEIGHT - CHART_PADDING_BOTTOM + 4}
                                    stroke={theme.colors.border.default}
                                    strokeOpacity={0.8}
                                    strokeWidth={1}
                                />
                            );
                        })}

                        {[0.25, 0.5, 0.75].map((ratio, rankIndex) => (
                            <Line
                                key={`rank-${rankIndex}`}
                                x1={CHART_PADDING_X}
                                y1={CHART_HEIGHT - CHART_PADDING_BOTTOM - (CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM) * ratio}
                                x2={chartWidth - CHART_PADDING_X}
                                y2={CHART_HEIGHT - CHART_PADDING_BOTTOM - (CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM) * ratio}
                                stroke={theme.colors.border.default}
                                strokeOpacity={0.35}
                                strokeWidth={1}
                                strokeDasharray="3 8"
                            />
                        ))}

                        {chartModel.series.map(({ label, points }) => {
                            const color = colorByLabel.get(label) ?? accentFallback;
                            return (
                                <React.Fragment key={label}>
                                    {points.map((point) => (
                                        <Circle
                                            key={`${label}-${point.bucketIndex}`}
                                            cx={point.x}
                                            cy={point.y}
                                            r={3.5}
                                            fill={color}
                                        />
                                    ))}
                                </React.Fragment>
                            );
                        })}

                        {timeline.map((bucket, bucketIndex) => {
                            const x = CHART_PADDING_X + (bucketCount <= 1 ? usableWidth / 2 : (bucketIndex / (bucketCount - 1)) * usableWidth);
                            return (
                                <SvgText
                                    key={`label-${bucket.bucketStartMs}`}
                                    x={x}
                                    y={CHART_HEIGHT - 10}
                                    fontSize="11"
                                    textAnchor="middle"
                                    fill={theme.colors.text.secondary}
                                >
                                    {formatBucketLabel(bucket.bucketStartMs, bucketCount)}
                                </SvgText>
                            );
                        })}
                    </Svg>
                    {/* Series lines draw themselves in once via the kit's DrawnLinePath
                        (Skia path-trim at `full`, opacity fade otherwise/web). */}
                    {chartModel.series.map(({ label, points }) => {
                        const color = colorByLabel.get(label) ?? accentFallback;
                        const path = buildSegmentPath(points);
                        if (!path) return null;
                        return (
                            <View
                                key={`line-${label}`}
                                pointerEvents="none"
                                style={{ position: 'absolute', top: 0, left: 0 }}
                            >
                                <DrawnLinePath
                                    path={path}
                                    width={chartWidth}
                                    height={CHART_HEIGHT}
                                    color={color}
                                    strokeWidth={2}
                                    animateOnMount={entrancesEnabled}
                                    testID={`usage-journey-line-${label}`}
                                />
                            </View>
                        );
                    })}
                    {chartModel.series.map(({ label, points }) => {
                        const color = colorByLabel.get(label) ?? accentFallback;
                        return points.map((point) => {
                            const bucketTimestamp = timeline[point.bucketIndex]?.bucketStartMs ?? 0;
                            return (
                                <View
                                    key={`tooltip-${label}-${point.bucketIndex}`}
                                    style={[styles.pointHitArea, { left: point.x, top: point.y }]}
                                >
                                    <ChartTooltip
                                        triggerTestID="usage-journey-point-trigger"
                                        title={label}
                                        subtitle={formatBucketLabel(bucketTimestamp, bucketCount)}
                                        value={formatMetricValue(point.value, metric, currency)}
                                        accentColor={color}
                                    >
                                        <View style={styles.pointHitTarget} />
                                    </ChartTooltip>
                                </View>
                            );
                        });
                    })}
                </View>
            </HorizontalChartFrame>

            {chartModel.latestLeaders.length > 0 ? (
                <View style={styles.latestSummary}>
                    <Text style={styles.latestLabel}>{formatBucketLabel(timeline[timeline.length - 1]?.bucketStartMs ?? 0, bucketCount)}</Text>
                    <View style={styles.latestRow}>
                        {chartModel.latestLeaders.map((leader) => (
                            <View key={leader.key} style={styles.latestPill}>
                                <View
                                    style={[
                                        styles.latestPillDot,
                                        { backgroundColor: colorByLabel.get(leader.label ?? '') ?? accentFallback },
                                    ]}
                                />
                                <Text style={styles.latestPillText}>{leader.label}</Text>
                            </View>
                        ))}
                    </View>
                </View>
            ) : null}
        </View>
    );
}
