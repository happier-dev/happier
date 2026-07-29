import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { Circle, Svg } from 'react-native-svg';

import { ringGeometry, sweepDashOffset } from './gaugeMath';

/**
 * Tier-2 context gauge: an animated stroke-sweep ring. This is the instrument
 * sibling of `sessions/usage/TokenUsageRing` (same geometry vocabulary via
 * `ringGeometry`/`sweepDashOffset`), extended with a Reanimated-driven sweep so
 * the fill glides between values on the UI thread. Colors always arrive
 * pre-resolved from the theme — this component never picks colors itself.
 */

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export const GAUGE_RING_STROKE_WIDTH = 1.5;

export type GaugeRingProps = Readonly<{
    /** Animated fill percentage 0–100 (already spring-smoothed by the owner). */
    fillPct: SharedValue<number>;
    /** Animated stroke color (tone-resolved on the UI thread by the owner). */
    strokeColor: SharedValue<string>;
    size: number;
    trackColor: string;
    /** Stale: track + a small center dot, no fill sweep. */
    stale?: boolean;
    /** Dot color for the stale marker. */
    staleDotColor?: string;
    testID?: string;
}>;

export const GaugeRing = React.memo(function GaugeRing(props: GaugeRingProps) {
    const { theme } = useUnistyles();
    const size = props.size;
    const { radius, circumference } = ringGeometry(size, GAUGE_RING_STROKE_WIDTH);

    const sweepProps = useAnimatedProps(() => ({
        strokeDashoffset: sweepDashOffset(circumference, props.fillPct.value),
        stroke: props.strokeColor.value,
    }));

    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            style={[styles.root, { width: size, height: size, borderRadius: size / 2 }]}
        >
            <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={props.trackColor}
                    strokeWidth={GAUGE_RING_STROKE_WIDTH}
                />
                {props.stale ? (
                    <Circle
                        cx={size / 2}
                        cy={size / 2}
                        r={Math.max(1, size * 0.08)}
                        fill={props.staleDotColor ?? theme.colors.text.tertiary}
                    />
                ) : (
                    <AnimatedCircle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        fill="none"
                        strokeWidth={GAUGE_RING_STROKE_WIDTH}
                        strokeLinecap="round"
                        strokeDasharray={`${circumference} ${circumference}`}
                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                        animatedProps={sweepProps}
                    />
                )}
            </Svg>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    root: {
        position: 'relative',
        justifyContent: 'center',
        alignItems: 'center',
    },
}));
