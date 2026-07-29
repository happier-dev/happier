import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type { VoiceSurfaceState } from './resolveVoiceSurfaceState';

const SETTLE_EASING = Easing.bezier(0.23, 1, 0.32, 1);
const INTERRUPTION_SPRING = { damping: 20, stiffness: 220, mass: 0.8 } as const;

/**
 * Bounded feedback for exceptional whole-surface transitions only.
 * Normal connecting/listening/thinking/speaking energy stays localized in the
 * status indicator; the entire surface must not float perpetually by phase.
 */
export const VoiceSurfaceMotionFrame = React.memo(function VoiceSurfaceMotionFrame(props: Readonly<{
    surfaceState: VoiceSurfaceState;
    children?: React.ReactNode;
}>) {
    const reduceMotion = useReducedMotionPreference();
    const offsetX = useSharedValue(0);
    const scale = useSharedValue(1);
    const previousState = React.useRef<VoiceSurfaceState>(props.surfaceState);

    React.useEffect(() => {
        if (reduceMotion) {
            offsetX.set(0);
            scale.set(1);
            previousState.current = props.surfaceState;
            return;
        }
        if (props.surfaceState === 'error' && previousState.current !== 'error') {
            offsetX.set(withSequence(
                withTiming(2, { duration: 70, easing: SETTLE_EASING }),
                withTiming(-2, { duration: 70, easing: SETTLE_EASING }),
                withTiming(1, { duration: 60, easing: SETTLE_EASING }),
                withTiming(0, { duration: 80, easing: SETTLE_EASING }),
            ));
        } else if (props.surfaceState === 'interrupted' && previousState.current !== 'interrupted') {
            scale.set(withSequence(
                withTiming(0.992, { duration: 90, easing: SETTLE_EASING }),
                withSpring(1, INTERRUPTION_SPRING),
            ));
        } else {
            offsetX.set(withTiming(0, { duration: 140, easing: SETTLE_EASING }));
            scale.set(withTiming(1, { duration: 140, easing: SETTLE_EASING }));
        }
        previousState.current = props.surfaceState;
    }, [offsetX, props.surfaceState, reduceMotion, scale]);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: offsetX.get() },
            { scale: scale.get() },
        ],
    }));

    if (reduceMotion) return <View style={STATIC_FRAME}>{props.children}</View>;
    return <Animated.View style={[STATIC_FRAME, animatedStyle]}>{props.children}</Animated.View>;
});

const STATIC_FRAME = { alignSelf: 'stretch' as const, width: '100%' as const };
