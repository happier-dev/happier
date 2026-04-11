import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsageMetric, UsageTrendPoint } from '@/sync/api/account/usageAnalytics';

type UsageVolumeBubbleChartProps = Readonly<{
    points: readonly UsageTrendPoint[];
    metric: UsageMetric;
    height?: number;
    testID?: string;
}>;

const MIN_BUBBLE_SIZE = 12;
const MAX_BUBBLE_SIZE = 88;
const MAX_POINTS = 30;

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 14,
    },
    emptyState: {
        paddingVertical: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    scroller: {
        flexGrow: 0,
    },
    chartCanvas: {
        flexDirection: 'row',
        alignItems: 'stretch',
        paddingHorizontal: 4,
        paddingTop: 4,
    },
    column: {
        width: 56,
        minHeight: 228,
        alignItems: 'center',
        position: 'relative',
    },
    guide: {
        position: 'absolute',
        top: 0,
        bottom: 24,
        width: 1,
        backgroundColor: theme.colors.divider,
        opacity: 0.8,
    },
    valueLabel: {
        minHeight: 16,
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.textSecondary,
    },
    bubbleWrap: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: 10,
        paddingTop: 16,
    },
    bubble: {
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHigh,
    },
    bubbleHighlighted: {
        borderColor: 'transparent',
    },
    label: {
        marginTop: 6,
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        paddingHorizontal: 6,
    },
    footerMetric: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
    footerValue: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

function formatMetricValue(value: number, metric: UsageMetric): string {
    if (metric === 'cost') {
        if (value >= 100) {
            return `$${value.toFixed(0)}`;
        }
        if (value >= 10) {
            return `$${value.toFixed(1)}`;
        }
        return `$${value.toFixed(2)}`;
    }

    if (value >= 1_000_000_000) {
        return `${(value / 1_000_000_000).toFixed(1)}B`;
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }
    return value.toFixed(0);
}

function formatBucketLabel(timestampSeconds: number, pointCount: number): string {
    const date = new Date(timestampSeconds * 1000);
    if (pointCount <= 2) {
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
    }
    if (pointCount <= 8) {
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date);
}

function getPointValue(point: UsageTrendPoint, metric: UsageMetric): number {
    return metric === 'cost' ? point.cost : point.tokens;
}

export function UsageVolumeBubbleChart(props: UsageVolumeBubbleChartProps): React.ReactElement {
    const { points, metric, height = 240, testID } = props;
    const { theme } = useUnistyles();

    if (points.length === 0) {
        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>{t('usage.noData')}</Text>
            </View>
        );
    }

    const displayPoints = points.length > MAX_POINTS ? points.slice(-MAX_POINTS) : [...points];
    const maxValue = Math.max(...displayPoints.map((point) => getPointValue(point, metric)), 1);
    const accentColor = metric === 'cost' ? theme.colors.accent.orange : theme.colors.accent.blue;
    const topPoint = [...displayPoints].sort((left, right) => getPointValue(right, metric) - getPointValue(left, metric))[0] ?? null;
    const total = displayPoints.reduce((sum, point) => sum + getPointValue(point, metric), 0);

    return (
        <View testID={testID} style={styles.container}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroller}>
                <View style={[styles.chartCanvas, { minHeight: height }]}>
                    {displayPoints.map((point, index) => {
                        const value = getPointValue(point, metric);
                        const ratio = maxValue <= 0 ? 0 : value / maxValue;
                        const size = value <= 0
                            ? MIN_BUBBLE_SIZE
                            : MIN_BUBBLE_SIZE + (MAX_BUBBLE_SIZE - MIN_BUBBLE_SIZE) * Math.sqrt(ratio);
                        const isTopPoint = topPoint != null && point.timestamp === topPoint.timestamp && value === getPointValue(topPoint, metric);

                        return (
                            <View key={`${point.timestamp}-${index}`} style={[styles.column, { minHeight: height }]}>
                                <View style={styles.guide} />
                                <Text style={styles.valueLabel}>{isTopPoint ? formatMetricValue(value, metric) : ' '}</Text>
                                <View style={styles.bubbleWrap}>
                                    <View
                                        style={[
                                            styles.bubble,
                                            {
                                                width: size,
                                                height: size,
                                                backgroundColor: isTopPoint ? accentColor : theme.colors.surfaceHigh,
                                                opacity: isTopPoint ? 0.92 : Math.max(0.18, ratio * 0.78),
                                            },
                                            isTopPoint ? styles.bubbleHighlighted : null,
                                        ]}
                                    />
                                </View>
                                <Text numberOfLines={2} style={styles.label}>
                                    {formatBucketLabel(point.timestamp, displayPoints.length)}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            </ScrollView>

            <View style={styles.footer}>
                <Text style={styles.footerMetric}>
                    {t('usage.totalTokens')}: <Text style={styles.footerValue}>{formatMetricValue(total, metric)}</Text>
                </Text>
                {topPoint ? (
                    <Text style={styles.footerMetric}>
                        {formatBucketLabel(topPoint.timestamp, displayPoints.length)} · <Text style={styles.footerValue}>{formatMetricValue(getPointValue(topPoint, metric), metric)}</Text>
                    </Text>
                ) : null}
            </View>
        </View>
    );
}
