import * as React from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Path, Svg } from 'react-native-svg';

import { INSTRUMENT_DURATIONS } from '../motion/motionTokens';

/**
 * Shared non-Skia fallback for `DrawnLinePath`: the same stroked SVG path with
 * a single opacity fade-in on mount (crossfade duration at `minimal`, entrance
 * duration otherwise). Used verbatim on web and as the native tier-2 branch.
 */

export type LineFadeProps = Readonly<{
    path: string;
    width: number;
    height: number;
    color: string;
    strokeWidth?: number;
    /** False = instant appearance (minimal level with animation fully off). */
    animateEntrance: boolean;
    /** Entrance duration; defaults to the kit entrance. */
    durationMs?: number;
    testID?: string;
}>;

export const LineFade = React.memo(function LineFade(props: LineFadeProps) {
    const opacity = useSharedValue(props.animateEntrance ? 0 : 1);

    React.useEffect(() => {
        if (!props.animateEntrance) return;
        opacity.value = withTiming(1, {
            duration: props.durationMs ?? INSTRUMENT_DURATIONS.entrance,
        });
        // Entrance plays ONCE per mount by design.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

    return (
        <Animated.View testID={props.testID} style={style}>
            <Svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`}>
                <Path
                    d={props.path}
                    stroke={props.color}
                    strokeWidth={props.strokeWidth ?? 1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                />
            </Svg>
        </Animated.View>
    );
});
