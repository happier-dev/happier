import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { ChartTooltip } from '@/components/ui/charts';
import { INSTRUMENT_SPRINGS, useMotionPreferences } from '@/components/instrument';
import { usageMeterFill } from './usageAccent';
import { useEntrancesEnabled } from './sections/EntranceView';

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
        color: theme.colors.text.primary,
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    barContainer: {
        height: 8,
        backgroundColor: theme.colors.border.default,
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
        backgroundColor: theme.colors.surface.inset,
    },
}));

/**
 * Bar fill that springs to its width ONCE on mount (motion-gated; minimal /
 * reduce-motion renders the final width statically). Later value changes spring
 * to the new width — a response to the user's filter gesture, not an idle loop.
 */
const AnimatedFillWidth: React.FC<Readonly<{
    widthPct: number;
    animateEntrance: boolean;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>> = ({ widthPct, animateEntrance, children, style, testID }) => {
    const width = useSharedValue(animateEntrance ? 0 : widthPct);

    React.useEffect(() => {
        width.value = withSpring(widthPct, INSTRUMENT_SPRINGS.standard);
    }, [width, widthPct]);

    const animatedStyle = useAnimatedStyle(() => ({
        width: `${width.value}%`,
    }));

    if (!animateEntrance) {
        return (
            <View testID={testID} style={[style, { width: `${widthPct}%` }]}>
                {children}
            </View>
        );
    }

    return (
        <Animated.View testID={testID} style={[style, animatedStyle]}>
            {children}
        </Animated.View>
    );
};

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
    const motion = useMotionPreferences();
    // Single guard source (R-L6 F1): when the surrounding section's entrance
    // already played this session, render the final width immediately.
    const entrancesEnabled = useEntrancesEnabled();
    const percentage = maxValue > 0 ? (value / maxValue) * 100 : 0;
    // ONE-accent system (D-1): unspecified fills default to the monochrome
    // neutral; callers pass the signature accent only for the row that means
    // something (leader / selection / threshold).
    const fillColor = color || usageMeterFill(theme, false);
    const animateEntrance = motion.entrance.kind === 'travel' && entrancesEnabled;

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
                        <AnimatedFillWidth
                            testID={testID ? `${testID}-anchor` : undefined}
                            widthPct={Math.max(8, Math.min(percentage, 100))}
                            animateEntrance={animateEntrance}
                            style={styles.barTooltipAnchor}
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
                        </AnimatedFillWidth>
                    </ChartTooltip>
                ) : (
                    <AnimatedFillWidth
                        widthPct={Math.min(percentage, 100)}
                        animateEntrance={animateEntrance}
                        style={styles.barFill}
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
                    </AnimatedFillWidth>
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
                accessibilityRole="button"
                accessibilityLabel={`${label} · ${displayValue}`}
                accessibilityState={{ selected: active }}
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
