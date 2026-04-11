import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { UsageAnalyticsTimelineBucket } from '@/sync/api/account/usageAnalytics';

type UsageJourneyChartProps = Readonly<{
    timeline: readonly UsageAnalyticsTimelineBucket[];
    testID?: string;
}>;

type RankPoint = Readonly<{
    x: number;
    y: number;
    bucketIndex: number;
}>;

const CHART_HEIGHT = 188;
const CHART_WIDTH = 680;
const CHART_PADDING_TOP = 26;
const CHART_PADDING_BOTTOM = 34;
const CHART_PADDING_X = 18;
const RANK_Y = [38, 86, 134] as const;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 14,
    },
    chartWrap: {
        overflow: 'hidden',
    },
    latestSummary: {
        gap: 8,
        paddingHorizontal: 2,
    },
    latestLabel: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.groupped.sectionTitle,
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
        backgroundColor: theme.colors.surfaceHigh,
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
        color: theme.colors.text,
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
    return new Intl.DateTimeFormat(undefined, bucketCount > 6 ? { month: 'short' } : { month: 'short', day: 'numeric' }).format(date);
}

export function UsageJourneyChart(props: UsageJourneyChartProps): React.ReactElement | null {
    const { timeline, testID } = props;
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();

    if (timeline.length === 0) {
        return null;
    }

    const palette = [
        theme.colors.accent.orange,
        theme.colors.accent.blue,
        theme.colors.accent.purple,
        theme.colors.accent.green,
        theme.colors.accent.indigo,
        theme.colors.accent.yellow,
    ];

    const labels = Array.from(
        new Set(
            timeline.flatMap((bucket) =>
                bucket.leaders
                    .slice(0, 3)
                    .map((leader) => leader.label)
                    .filter((value): value is string => typeof value === 'string' && value.length > 0)
            )
        )
    ).slice(0, palette.length);
    const colorByLabel = new Map(labels.map((label, index) => [label, palette[index % palette.length]]));

    const usableWidth = CHART_WIDTH - CHART_PADDING_X * 2;
    const bucketCount = timeline.length;
    const seriesByLabel = new Map<string, RankPoint[]>();

    timeline.forEach((bucket, bucketIndex) => {
        const x = CHART_PADDING_X + (bucketCount <= 1 ? usableWidth / 2 : (bucketIndex / (bucketCount - 1)) * usableWidth);
        bucket.leaders.slice(0, 3).forEach((leader, rankIndex) => {
            if (!leader.label) return;
            const points = seriesByLabel.get(leader.label) ?? [];
            points.push({
                x,
                y: RANK_Y[Math.min(rankIndex, RANK_Y.length - 1)],
                bucketIndex,
            });
            seriesByLabel.set(leader.label, points);
        });
    });

    const latestBucket = timeline[timeline.length - 1] ?? null;
    const latestLeaders = latestBucket?.leaders.slice(0, 3).filter((leader) => typeof leader.label === 'string' && leader.label.length > 0) ?? [];
    const renderedChartWidth = Math.max(CHART_WIDTH, Math.round(width - 96));

    return (
        <View testID={testID} style={styles.container}>
            <View style={styles.chartWrap}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <Svg
                        width={renderedChartWidth}
                        height={CHART_HEIGHT}
                        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                        preserveAspectRatio="xMinYMid meet"
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
                                    stroke={theme.colors.divider}
                                    strokeOpacity={0.8}
                                    strokeWidth={1}
                                />
                            );
                        })}

                        {RANK_Y.map((y, rankIndex) => (
                            <Line
                                key={`rank-${rankIndex}`}
                                x1={CHART_PADDING_X}
                                y1={y}
                                x2={CHART_WIDTH - CHART_PADDING_X}
                                y2={y}
                                stroke={theme.colors.divider}
                                strokeOpacity={0.35}
                                strokeWidth={1}
                                strokeDasharray="3 8"
                            />
                        ))}

                        {Array.from(seriesByLabel.entries()).map(([label, points]) => {
                            const color = colorByLabel.get(label) ?? theme.colors.accent.blue;
                            return (
                                <React.Fragment key={label}>
                                    <Path
                                        d={buildSegmentPath(points)}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={2}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeDasharray="2 6"
                                    />
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
                                    fill={theme.colors.textSecondary}
                                >
                                    {formatBucketLabel(bucket.bucketStartMs, bucketCount)}
                                </SvgText>
                            );
                        })}
                    </Svg>
                </ScrollView>
            </View>

            {latestBucket ? (
                <View style={styles.latestSummary}>
                    <Text style={styles.latestLabel}>{formatBucketLabel(latestBucket.bucketStartMs, bucketCount)}</Text>
                    <View style={styles.latestRow}>
                        {latestLeaders.map((leader) => (
                            <View key={leader.key} style={styles.latestPill}>
                                <View
                                    style={[
                                        styles.latestPillDot,
                                        { backgroundColor: colorByLabel.get(leader.label ?? '') ?? theme.colors.accent.blue },
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
