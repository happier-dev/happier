import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ChartTooltip, resolveHeatmapColor } from '@/components/ui/charts';
import { RippleGrid } from '@/components/instrument';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { UsageMetric, UsageSummaryActivityPoint, UsageTrendPoint } from '@/sync/api/account/usageAnalytics';
import { useEntrancesEnabled } from './sections/EntranceView';

type UsageRankBarRow = Readonly<{
    label: string;
    value: number;
}>;

const styles = StyleSheet.create((theme) => ({
    activitySquare: {
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: theme.colors.background.canvas,
    },
    progressTrack: {
        height: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.background.canvas,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: 999,
    },
    rankBars: {
        gap: 9,
    },
    rankBarRow: {
        gap: 4,
    },
    rankBarLabelRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 8,
    },
    rankBarLabel: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
        flex: 1,
    },
    rankBarValue: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    rankBarTrack: {
        height: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.background.canvas,
    },
    rankBarFill: {
        height: '100%',
        borderRadius: 999,
    },
    sparkBars: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 6,
        minHeight: 68,
    },
    sparkBarTrack: {
        width: 18,
        height: 64,
        borderRadius: 999,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    sparkBarFill: {
        width: '100%',
        borderRadius: 999,
    },
}));

function chunkActivity(activity: readonly UsageSummaryActivityPoint[], size: number): UsageSummaryActivityPoint[][] {
    const rows: UsageSummaryActivityPoint[][] = [];
    for (let index = 0; index < activity.length; index += size) {
        rows.push(activity.slice(index, index + size));
    }
    return rows;
}

export function UsageActivitySquareMatrix({
    activity,
    squareCount = 14,
    rowSize = 7,
    color,
    interactive = true,
}: Readonly<{
    activity: readonly UsageSummaryActivityPoint[];
    squareCount?: number;
    rowSize?: number;
    color: string;
    interactive?: boolean;
}>) {
    const { theme } = useUnistyles();
    // Single guard source (R-L6 F1): no ripple replay on a revisit remount.
    const entrancesEnabled = useEntrancesEnabled();
    const trimmedPoints = activity.slice(-squareCount);
    const fillerCount = Math.max(0, squareCount - trimmedPoints.length);
    const points = [
        ...Array.from({ length: fillerCount }, (_, index) => ({
            timestamp: -(index + 1),
            active: false,
            tokens: 0,
            cost: 0,
        })),
        ...trimmedPoints,
    ];
    const values = points.map((point) => point.tokens);

    function resolveActivityColor(point: UsageSummaryActivityPoint): string {
        return resolveHeatmapColor({
            value: point.active ? point.tokens : 0,
            values,
            baseColor: color,
            emptyColor: theme.colors.background.canvas,
        });
    }

    // Cells ripple in radially once on mount (RippleGrid, kit choreography);
    // testIDs keep the historical row/column addressing.
    const cells = chunkActivity(points, rowSize).flatMap((row, rowIndex) => row.map((point, pointIndex) => {
        if (!interactive) {
            return (
                <View
                    key={`${point.timestamp}-${rowIndex}-${pointIndex}`}
                    testID={`usage-activity-square-${rowIndex}-${pointIndex}`}
                    style={[
                        styles.activitySquare,
                        {
                            backgroundColor: resolveActivityColor(point),
                        },
                    ]}
                />
            );
        }

        return (
            <ChartTooltip
                key={`${point.timestamp}-${rowIndex}-${pointIndex}`}
                triggerTestID={`usage-activity-square-${rowIndex}-${pointIndex}`}
                title={point.active ? new Date(point.timestamp).toLocaleDateString() : '—'}
                subtitle={point.active ? undefined : t('usage.noData.title')}
                value={point.active ? point.tokens.toLocaleString() : '0'}
                accentColor={color}
                disabled={!point.active}
            >
                <View
                    style={[
                        styles.activitySquare,
                        {
                            backgroundColor: resolveActivityColor(point),
                        },
                    ]}
                />
            </ChartTooltip>
        );
    }));

    return (
        <RippleGrid columns={rowSize} cellSize={16} gap={7} animateOnMount={entrancesEnabled}>
            {cells}
        </RippleGrid>
    );
}

export function UsageSparkBars({
    points,
    metric,
    color,
    maxBars = 10,
}: Readonly<{
    points: readonly UsageTrendPoint[];
    metric: UsageMetric;
    color: string;
    maxBars?: number;
}>) {
    const recentPoints = points.slice(-maxBars);
    const values = recentPoints.map((point) => metric === 'cost' ? point.cost : point.tokens);
    const maxValue = Math.max(...values, 1);

    return (
        <View style={styles.sparkBars}>
            {recentPoints.map((point, index) => {
                const value = metric === 'cost' ? point.cost : point.tokens;
                const ratio = maxValue <= 0 ? 0 : value / maxValue;

                return (
                    <ChartTooltip
                        key={`${point.timestamp}-${index}`}
                        triggerTestID={`usage-spark-bar-${index}`}
                        title={new Date(point.timestamp * 1000).toLocaleDateString()}
                        subtitle={metric === 'cost' ? t('usage.cost') : t('usage.tokens')}
                        value={metric === 'cost' ? value.toFixed(2) : value.toLocaleString()}
                        accentColor={color}
                    >
                        <View style={styles.sparkBarTrack}>
                            <View
                                style={[
                                    styles.sparkBarFill,
                                    {
                                        height: `${Math.max(14, Math.round(ratio * 100))}%`,
                                        backgroundColor: color,
                                        opacity: 0.42 + ratio * 0.58,
                                    },
                                ]}
                            />
                        </View>
                    </ChartTooltip>
                );
            })}
        </View>
    );
}

export function UsageProgressMeter({
    ratio,
    color,
}: Readonly<{
    ratio: number;
    color: string;
}>) {
    const widthPercentage = ratio <= 0 ? 0 : Math.min(100, Math.max(8, ratio * 100));

    return (
        <View style={styles.progressTrack}>
            <View
                style={[
                    styles.progressFill,
                    {
                        width: `${widthPercentage}%`,
                        backgroundColor: color,
                        opacity: 0.92,
                    },
                ]}
            />
        </View>
    );
}

export function UsageRankBars({
    rows,
    color,
}: Readonly<{
    rows: readonly UsageRankBarRow[];
    color: string;
}>) {
    const peak = Math.max(...rows.map((row) => row.value), 1);

    return (
        <View style={styles.rankBars}>
            {rows.map((row) => (
                <ChartTooltip
                    key={row.label}
                    triggerTestID={`usage-rank-bar-${row.label}`}
                    title={row.label}
                    value={row.value.toLocaleString()}
                    accentColor={color}
                >
                    <View style={styles.rankBarRow}>
                        <View style={styles.rankBarLabelRow}>
                            <Text numberOfLines={1} style={styles.rankBarLabel}>{row.label}</Text>
                            <Text style={styles.rankBarValue}>{row.value.toLocaleString()}</Text>
                        </View>
                        <View style={styles.rankBarTrack}>
                            <View
                                style={[
                                    styles.rankBarFill,
                                    {
                                        backgroundColor: color,
                                        width: `${Math.max(10, Math.min(100, (row.value / peak) * 100))}%`,
                                        opacity: row.value > 0 ? 0.92 : 0.25,
                                    },
                                ]}
                            />
                        </View>
                    </View>
                </ChartTooltip>
            ))}
        </View>
    );
}
