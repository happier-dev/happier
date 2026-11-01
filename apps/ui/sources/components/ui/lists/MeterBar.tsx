import * as React from 'react';
import { Animated, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveMotionPresentation } from '@/components/ui/motion/reducedMotionTable';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type MeterTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface MeterBarProps {
    tone: MeterTone;
    /**
     * Fill fraction in 0..1 (clamped). Canonical semantic: fill = consumed / progress — the bar
     * GROWS as work happens (tokens consumed, agents completed). Pass the progress ratio directly;
     * do not invert it.
     */
    fillFraction: number;
    caption?: React.ReactNode;
    /** Track height in px (default 6). */
    height?: number;
    trackColor?: string;
    fillColor?: string;
    /** Animate transfer progress; capacity meters retain their immediate updates. */
    animated?: boolean;
    /**
     * When the bar reports progress (not a capacity), its accessible name. The bar then exposes
     * `progressbar` semantics with the fill as a 0–100 value.
     */
    progressAccessibilityLabel?: string;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

const DEFAULT_TRACK_HEIGHT_PX = 6;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        width: '100%',
        borderRadius: 999,
        overflow: 'hidden',
    },
    fill: {
        height: '100%',
        borderRadius: 999,
    },
    caption: {
        color: theme.colors.text.secondary,
        marginTop: 4,
        fontSize: 12,
        lineHeight: 16,
    },
}));

export const MeterBar = React.memo<MeterBarProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const height = props.height ?? DEFAULT_TRACK_HEIGHT_PX;
    const fill = clamp01(props.fillFraction);
    // Read the token directly — never apply a runtime opacity/rgba transform to a
    // theme token (web var-ification turns such transforms into silent no-ops).
    const fillColor = props.fillColor ?? theme.colors.state[props.tone].foreground;
    const trackColor = props.trackColor ?? theme.colors.surface.pressedOverlay;
    const reducedMotion = useReducedMotionPreference();
    const animatedFill = React.useRef(new Animated.Value(fill)).current;
    React.useEffect(() => {
        if (!props.animated || resolveMotionPresentation('progressFill', reducedMotion) !== 'animate') {
            animatedFill.setValue(fill);
            return;
        }
        // Transfers report progress every ~100ms and each report restarts this animation. A decelerating
        // curve then lurches and stalls on every report; a linear glide spanning a few reports reads as
        // one continuous motion.
        const animation = Animated.timing(animatedFill, {
            toValue: fill,
            duration: motionTokens.durationMs.slow,
            easing: motionTokens.easing.linear,
            useNativeDriver: Platform.OS !== 'web',
        });
        animation.start();
        return () => animation.stop();
    }, [animatedFill, fill, props.animated, reducedMotion]);

    return (
        <View
            testID={props.testID}
            style={props.style}
            {...(props.progressAccessibilityLabel ? {
                accessible: true,
                accessibilityRole: 'progressbar' as const,
                accessibilityLabel: props.progressAccessibilityLabel,
                accessibilityValue: { min: 0, max: 100, now: Math.round(fill * 100) },
            } : null)}
        >
            <View
                testID={props.testID ? `${props.testID}:track` : undefined}
                style={[styles.track, { height, backgroundColor: trackColor }]}
            >
                <Animated.View
                    testID={props.testID ? `${props.testID}:fill` : undefined}
                    style={[
                        styles.fill,
                        { backgroundColor: fillColor },
                        props.animated
                            // Native-driven layout animations throw; scale from the leading edge instead.
                            ? { width: '100%', transformOrigin: 'left', transform: [{ scaleX: animatedFill }] }
                            : { width: `${fill * 100}%` },
                    ]}
                />
            </View>
            {props.caption != null ? (
                typeof props.caption === 'string' || typeof props.caption === 'number' ? (
                    <Text
                        testID={props.testID ? `${props.testID}:caption` : undefined}
                        style={styles.caption}
                    >
                        {props.caption}
                    </Text>
                ) : (
                    props.caption
                )
            ) : null}
        </View>
    );
});

MeterBar.displayName = 'MeterBar';
