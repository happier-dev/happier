import type {
    HappierAgentCursorChannel,
    HappierAgentCursorLayerProps,
    HappierAgentCursorMotion,
    HappierAgentCursorMotionDriver,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

import { reanimatedMotionTokens } from './reanimatedMotionTokens';

type CursorValues = Readonly<Record<HappierAgentCursorChannel | 'pointer' | 'ring', SharedValue<number>>>;

type ReanimatedAgentCursorMotion = HappierAgentCursorMotion & Readonly<{ values: CursorValues }>;

function useReanimatedAgentCursorMotion(): ReanimatedAgentCursorMotion {
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const ringLeft = useSharedValue(0);
    const ringTop = useSharedValue(0);
    const ringWidth = useSharedValue(0);
    const ringHeight = useSharedValue(0);
    const pointer = useSharedValue(0);
    const ring = useSharedValue(0);
    return React.useMemo(() => {
        const values: CursorValues = { x, y, ringLeft, ringTop, ringWidth, ringHeight, pointer, ring };
        return {
            values,
            set: (channel, value) => {
                values[channel].value = value;
            },
            travel: (channel, value) => {
                values[channel].value = withSpring(value, reanimatedMotionTokens.spring.travel);
            },
            setOpacity: (layer, value) => {
                values[layer].value = value;
            },
            fade: (layer, to, curve, onDone) => {
                values[layer].value = withTiming(to, {
                    duration: reanimatedMotionTokens.durationMs.fast,
                    easing: reanimatedMotionTokens.easing[curve],
                }, onDone ? (finished) => {
                    'worklet';
                    // A fade a later call redirected reports unfinished and is not "done".
                    if (finished) runOnJS(onDone)();
                } : undefined);
            },
            ringOpacity: () => values.ring.value,
        };
    }, [pointer, ring, ringHeight, ringLeft, ringTop, ringWidth, x, y]);
}

function CursorPointer(props: HappierAgentCursorLayerProps<ReanimatedAgentCursorMotion>): React.ReactElement {
    const { values } = props.motion;
    const style = useAnimatedStyle(() => ({
        opacity: values.pointer.value,
        transform: [{ translateX: values.x.value }, { translateY: values.y.value }],
    }));
    return (
        <Animated.View testID={props.testID} style={[props.style as React.ComponentProps<typeof Animated.View>['style'], style]}>
            {props.children}
        </Animated.View>
    );
}

function CursorRing(props: HappierAgentCursorLayerProps<ReanimatedAgentCursorMotion>): React.ReactElement {
    const { values } = props.motion;
    const style = useAnimatedStyle(() => ({
        opacity: values.ring.value,
        left: values.ringLeft.value,
        top: values.ringTop.value,
        width: values.ringWidth.value,
        height: values.ringHeight.value,
    }));
    return (
        <Animated.View testID={props.testID} style={[props.style as React.ComponentProps<typeof Animated.View>['style'], style]}>
            {props.children}
        </Animated.View>
    );
}

/**
 * Happier core's motion for the shared agent cursor (`HappierAgentCursor`): the hand and its ring
 * travel together on the critically damped travel spring and fade on the fast duration, arriving on the
 * standard curve and leaving on the exit curve. The cursor decides what moves; this decides how.
 */
export const reanimatedAgentCursorMotion: HappierAgentCursorMotionDriver<ReanimatedAgentCursorMotion> = {
    useMotion: useReanimatedAgentCursorMotion,
    Pointer: CursorPointer,
    Ring: CursorRing,
};
