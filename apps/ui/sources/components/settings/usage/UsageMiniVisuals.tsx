import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { UsageSummaryActivityPoint } from '@/sync/api/account/usageAnalytics';

const styles = StyleSheet.create((theme) => ({
    activityRowStack: {
        gap: 4,
    },
    activityRow: {
        flexDirection: 'row',
        gap: 4,
    },
    activitySquare: {
        flex: 1,
        height: 10,
        borderRadius: 3,
        backgroundColor: theme.colors.divider,
    },
    progressTrack: {
        height: 7,
        borderRadius: 999,
        backgroundColor: theme.colors.surfacePressedOverlay,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: 999,
    },
    sparkBars: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 4,
        minHeight: 38,
        paddingTop: 2,
    },
    sparkBar: {
        flex: 1,
        minHeight: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.accent.green,
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
}: Readonly<{
    activity: readonly UsageSummaryActivityPoint[];
    squareCount?: number;
    rowSize?: number;
    color: string;
}>) {
    const points = activity.slice(-squareCount);
    const peak = Math.max(...points.map((point) => point.tokens), 1);

    return (
        <View style={styles.activityRowStack}>
            {chunkActivity(points, rowSize).map((row, rowIndex) => (
                <View key={`row-${rowIndex}`} style={styles.activityRow}>
                    {row.map((point, pointIndex) => (
                        <View
                            key={`${point.timestamp}-${pointIndex}`}
                            style={[
                                styles.activitySquare,
                                point.active
                                    ? {
                                        backgroundColor: color,
                                        opacity: Math.min(1, 0.35 + Math.min(0.65, point.tokens / peak)),
                                    }
                                    : null,
                            ]}
                        />
                    ))}
                </View>
            ))}
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
                    },
                ]}
            />
        </View>
    );
}

export function UsageSparkBars({
    activity,
    color,
}: Readonly<{
    activity: readonly UsageSummaryActivityPoint[];
    color: string;
}>) {
    const points = activity.slice(-6);
    const peak = Math.max(...points.map((point) => point.tokens), 1);

    return (
        <View style={styles.sparkBars}>
            {points.map((point, index) => (
                <View
                    key={`${point.timestamp}-${index}`}
                    style={[
                        styles.sparkBar,
                        {
                            backgroundColor: color,
                            height: Math.max(6, Math.round((point.tokens / peak) * 38)),
                            opacity: point.active ? 1 : 0.25,
                        },
                    ]}
                />
            ))}
        </View>
    );
}
