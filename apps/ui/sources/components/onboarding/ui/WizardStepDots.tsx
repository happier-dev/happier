import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type WizardStepDotsProps = Readonly<{
    currentStepIndex: number;
    maxVisibleDots?: number;
    stepCount: number;
}>;

const DEFAULT_MAX_VISIBLE_DOTS = 5;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 20,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 999,
        backgroundColor: theme.colors.text.secondary,
        opacity: 0.35,
    },
    activeDot: {
        width: 14,
        height: 7,
        backgroundColor: theme.colors.text.primary,
        opacity: 0.35,
    },
}));

function resolveVisibleDotRange(total: number, activeIndex: number, maxVisibleDots: number) {
    if (total <= maxVisibleDots) {
        return { start: 0, end: total };
    }

    const halfWindow = Math.floor(maxVisibleDots / 2);
    const maxStart = total - maxVisibleDots;
    const start = Math.max(0, Math.min(activeIndex - halfWindow, maxStart));
    return { start, end: start + maxVisibleDots };
}

export function WizardStepDots(props: WizardStepDotsProps) {
    useUnistyles();
    const styles = stylesheet;
    const dots = Math.max(0, props.stepCount);
    const activeIndex = Math.max(0, Math.min(props.currentStepIndex, dots - 1));
    const maxVisibleDots = Math.max(1, props.maxVisibleDots ?? DEFAULT_MAX_VISIBLE_DOTS);
    const visibleRange = resolveVisibleDotRange(dots, activeIndex, maxVisibleDots);
    const reducedMotion = useReducedMotionPreference();

    return (
        <View
            style={styles.root}
            testID="wizard-step-dots"
            accessibilityRole="progressbar"
            accessibilityValue={{ now: activeIndex + 1, min: 1, max: dots }}
        >
            {Array.from({ length: visibleRange.end - visibleRange.start }).map((_, offset) => {
                const index = visibleRange.start + offset;
                return (
                    <WizardStepDot
                        // eslint-disable-next-line react/no-array-index-key
                        key={index}
                        active={index === activeIndex}
                        baseStyle={styles.dot}
                        activeStyle={styles.activeDot}
                        reducedMotion={reducedMotion}
                    />
                );
            })}
        </View>
    );
}

type WizardStepDotProps = Readonly<{
    active: boolean;
    baseStyle: object;
    activeStyle: object;
    reducedMotion: boolean;
}>;

function WizardStepDot(props: WizardStepDotProps) {
    const progress = React.useRef(new Animated.Value(props.active ? 1 : 0)).current;

    React.useEffect(() => {
        if (props.reducedMotion) {
            progress.setValue(props.active ? 1 : 0);
            return;
        }
        Animated.timing(progress, {
            toValue: props.active ? 1 : 0,
            duration: 200,
            useNativeDriver: false,
        }).start();
    }, [props.active, progress, props.reducedMotion]);

    const animatedStyle = {
        width: progress.interpolate({ inputRange: [0, 1], outputRange: [7, 14] }),
    };

    return (
        <Animated.View
            style={[
                props.baseStyle,
                props.active ? props.activeStyle : null,
                animatedStyle,
            ]}
        />
    );
}
