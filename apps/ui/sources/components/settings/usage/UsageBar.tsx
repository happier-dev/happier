import React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ChartTooltip } from '@/components/ui/charts';

interface UsageBarProps {
    label: string;
    value: number;
    maxValue: number;
    color?: string;
    showPercentage?: boolean;
    height?: number;
    active?: boolean;
    testID?: string;
    onPress?: () => void;
    tooltipTitle?: string;
    tooltipSubtitle?: string;
    tooltipValue?: string;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
    },
    labelRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 4,
    },
    label: {
        fontSize: 14,
        color: theme.colors.text,
    },
    value: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    barContainer: {
        height: 8,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
        overflow: 'hidden',
        justifyContent: 'center',
    },
    barFill: {
        height: '100%',
        borderRadius: 4,
    },
    barTooltipAnchor: {
        alignSelf: 'flex-start',
        borderRadius: 4,
    },
    pressable: {
        borderRadius: 12,
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    pressableActive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
}));

export const UsageBar: React.FC<UsageBarProps> = ({
    label,
    value,
    maxValue,
    color,
    showPercentage = false,
    height = 8,
    active = false,
    testID,
    onPress,
    tooltipTitle,
    tooltipSubtitle,
    tooltipValue,
}) => {
    const { theme } = useUnistyles();
    const percentage = maxValue > 0 ? (value / maxValue) * 100 : 0;
    const fillColor = color || theme.colors.accent.blue;
    
    const displayValue = showPercentage 
        ? `${percentage.toFixed(1)}%`
        : value.toLocaleString();

    const content = (
        <>
            <View style={styles.labelRow}>
                <Text style={styles.label}>{label}</Text>
                <Text style={styles.value}>{displayValue}</Text>
            </View>
            <View style={[styles.barContainer, { height }]}>
                {tooltipTitle && tooltipValue ? (
                    <ChartTooltip
                        triggerTestID={testID ? `${testID}-trigger` : undefined}
                        title={tooltipTitle}
                        subtitle={tooltipSubtitle}
                        value={tooltipValue}
                        accentColor={fillColor}
                    >
                        <View
                            testID={testID ? `${testID}-anchor` : undefined}
                            style={[
                                styles.barTooltipAnchor,
                                {
                                    width: `${Math.max(8, Math.min(percentage, 100))}%`,
                                },
                            ]}
                        >
                            <View
                                style={[
                                    styles.barFill,
                                    {
                                        width: '100%',
                                        backgroundColor: fillColor,
                                    },
                                ]}
                            />
                        </View>
                    </ChartTooltip>
                ) : (
                    <View
                        style={[
                            styles.barFill,
                            {
                                width: `${Math.min(percentage, 100)}%`,
                                backgroundColor: fillColor,
                            },
                        ]}
                    />
                )}
            </View>
        </>
    );

    const containerStyle = [styles.container, styles.pressable, active && styles.pressableActive];

    if (typeof onPress === 'function') {
        return (
            <Pressable
                testID={testID}
                style={containerStyle}
                onPress={onPress}
            >
                {content}
            </Pressable>
        );
    }

    const view = (
        <View testID={testID} style={containerStyle}>
            {content}
        </View>
    );

    return view;
};
