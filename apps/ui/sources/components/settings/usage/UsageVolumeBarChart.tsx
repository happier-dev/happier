import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ChartTooltip, HorizontalChartFrame } from '@/components/ui/charts';
import type { UsageMetric, UsageTrendPoint } from '@/sync/api/account/usageAnalytics';
import { formatUsageCurrency } from './formatUsageCurrency';

type UsageVolumeBarChartProps = Readonly<{
    points: readonly UsageTrendPoint[];
    metric: UsageMetric;
    currency?: string;
    height?: number;
    testID?: string;
}>;

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
        color: theme.colors.text.secondary,
    },
    chartCanvas: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 4,
        paddingTop: 4,
        gap: 10,
    },
    column: {
        width: 42,
        minHeight: 228,
        alignItems: 'center',
        position: 'relative',
    },
    guide: {
        position: 'absolute',
        top: 0,
        bottom: 24,
        width: 1,
        backgroundColor: theme.colors.border.default,
        opacity: 0.7,
    },
    valueLabel: {
        minHeight: 16,
        ...Typography.default('semiBold'),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.secondary,
    },
    barWrap: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: 10,
        paddingTop: 16,
    },
    barTrack: {
        width: 22,
        height: '100%',
        maxHeight: 150,
        justifyContent: 'flex-end',
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        overflow: 'hidden',
    },
    barAnchor: {
        width: '100%',
        borderRadius: 999,
    },
    label: {
        marginTop: 6,
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.secondary,
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
        color: theme.colors.text.secondary,
    },
    footerValue: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

function formatMetricValue(value: number, metric: UsageMetric, currency: string): string {
    if (metric === 'cost') {
        return formatUsageCurrency(value, currency);
    }
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return value.toFixed(0);
}

function formatBucketLabel(timestampSeconds: number, pointCount: number): string {
    const date = new Date(timestampSeconds * 1000);
    if (pointCount <= 8) {
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date);
}

function getPointValue(point: UsageTrendPoint, metric: UsageMetric): number {
    return metric === 'cost' ? point.cost : point.tokens;
}

export function UsageVolumeBarChart(props: UsageVolumeBarChartProps): React.ReactElement {
    const { points, metric, currency = 'USD', height = 240, testID } = props;
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
    const contentWidth = Math.max(640, displayPoints.length * 58 + 18);

    return (
        <View testID={testID} style={styles.container}>
            <HorizontalChartFrame contentWidth={contentWidth}>
                <View style={[styles.chartCanvas, { minHeight: height }]}>
                    {displayPoints.map((point, index) => {
                        const value = getPointValue(point, metric);
                        const ratio = maxValue <= 0 ? 0 : value / maxValue;
                        const barHeight = Math.max(10, Math.round(ratio * 150));
                        const isTopPoint = topPoint != null && point.timestamp === topPoint.timestamp && value === getPointValue(topPoint, metric);

                        return (
                            <View key={`${point.timestamp}-${index}`} style={[styles.column, { minHeight: height }]}>
                                <View style={styles.guide} />
                                <Text style={styles.valueLabel}>{isTopPoint ? formatMetricValue(value, metric, currency) : ' '}</Text>
                                <View style={styles.barWrap}>
                                    <View style={styles.barTrack}>
                                        <ChartTooltip
                                            triggerTestID="usage-volume-point-trigger"
                                            title={formatBucketLabel(point.timestamp, displayPoints.length)}
                                            subtitle={metric === 'cost' ? t('usage.cost') : t('usage.tokens')}
                                            value={formatMetricValue(value, metric, currency)}
                                            accentColor={isTopPoint ? accentColor : theme.colors.accent.blue}
                                        >
                                            <View
                                                testID={`usage-volume-point-anchor-${index}`}
                                                style={[
                                                    styles.barAnchor,
                                                    {
                                                        height: barHeight,
                                                        backgroundColor: isTopPoint ? accentColor : theme.colors.accent.blue,
                                                        opacity: isTopPoint ? 0.95 : Math.max(0.35, ratio * 0.88),
                                                    },
                                                ]}
                                            />
                                        </ChartTooltip>
                                    </View>
                                </View>
                                <Text numberOfLines={2} style={styles.label}>
                                    {formatBucketLabel(point.timestamp, displayPoints.length)}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            </HorizontalChartFrame>

            <View style={styles.footer}>
                <Text style={styles.footerMetric}>
                    {metric === 'cost' ? t('usage.totalCost') : t('usage.totalTokens')}: <Text style={styles.footerValue}>{formatMetricValue(total, metric, currency)}</Text>
                </Text>
                {topPoint ? (
                    <Text style={styles.footerMetric}>
                        {formatBucketLabel(topPoint.timestamp, displayPoints.length)} · <Text style={styles.footerValue}>{formatMetricValue(getPointValue(topPoint, metric), metric, currency)}</Text>
                    </Text>
                ) : null}
            </View>
        </View>
    );
}
