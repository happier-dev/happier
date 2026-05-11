import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { UsageMetric, UsageTrendPoint } from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';

interface UsageChartProps {
    points: UsageTrendPoint[];
    metric: UsageMetric;
    height?: number;
    testID?: string;
    onBarPress?: (dataPoint: UsageTrendPoint, index: number) => void;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 16,
    },
    chartContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 8,
        paddingBottom: 40, // Space for labels
    },
    barWrapper: {
        flex: 1,
        alignItems: 'center',
        marginHorizontal: 2,
    },
    bar: {
        width: '100%',
        borderRadius: 4,
        minHeight: 2,
    },
    barValue: {
        fontSize: 10,
        color: theme.colors.text.secondary,
        marginBottom: 4,
        fontWeight: '600',
    },
    barLabel: {
        position: 'absolute',
        bottom: -24,
        fontSize: 10,
        color: theme.colors.text.secondary,
        transform: [{ rotate: '-45deg' }],
        width: 60,
        textAlign: 'center',
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.text.secondary,
    }
}));

export const UsageChart: React.FC<UsageChartProps> = ({
    points,
    metric,
    height = 200,
    testID,
    onBarPress
}) => {
    const { theme } = useUnistyles();
    
    if (!points || points.length === 0) {
        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>{t('usage.noData')}</Text>
            </View>
        );
    }
    
    // Calculate max value for scaling
    const getValueForDataPoint = (point: UsageTrendPoint): number => {
        if (metric === 'tokens') {
            return point.tokens;
        }
        return point.cost;
    };

    // Limit bars to show (for better visibility)
    const maxBarsToShow = 30;
    const displayData = points.length > maxBarsToShow
        ? points.slice(-maxBarsToShow)
        : points;

    const maxValue = Math.max(...displayData.map(getValueForDataPoint), 1);

    // Format date label
    const formatLabel = (timestamp: number): string => {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date);
        }
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
    };
    
    // Format value for display
    const formatValue = (value: number): string => {
        if (metric === 'cost') {
            return `$${value.toFixed(2)}`;
        } else if (value >= 1000000) {
            return `${(value / 1000000).toFixed(1)}M`;
        } else if (value >= 1000) {
            return `${(value / 1000).toFixed(1)}K`;
        } else {
            return value.toFixed(0);
        }
    };
    
    return (
        <View testID={testID} style={styles.container}>
            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={false}
                bounces={false}
            >
                <View style={[styles.chartContainer, { height }]}>
                    {displayData.map((point, index) => {
                        const value = getValueForDataPoint(point);
                        const barHeight = (value / maxValue) * height;
                        const showValue = value > 0 && barHeight > 20;
                        
                        return (
                            <Pressable
                                key={`${point.timestamp}-${index}`}
                                style={[styles.barWrapper, { minWidth: 40 }]}
                                onPress={() => onBarPress?.(point, index)}
                            >
                                {showValue && (
                                    <Text style={styles.barValue}>
                                        {formatValue(value)}
                                    </Text>
                                )}
                                <View
                                    style={[
                                        styles.bar,
                                        {
                                            height: Math.max(barHeight, 2),
                                            backgroundColor: metric === 'cost' 
                                                ? theme.colors.accent.orange
                                                : theme.colors.accent.blue,
                                        }
                                    ]}
                                />
                                <Text style={styles.barLabel}>
                                    {formatLabel(point.timestamp)}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
};
