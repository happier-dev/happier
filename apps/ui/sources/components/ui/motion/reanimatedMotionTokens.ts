import { Platform } from 'react-native';
import { Easing } from 'react-native-reanimated';

import { motionTokens } from './motionTokens';

const standardEasing = Easing.bezier(0.2, 0, 0, 1);

export const reanimatedMotionTokens = {
    durationMs: motionTokens.durationMs,
    /** `withSpring` configs for `motionTokens.spring` (Reanimated's duration + damping-ratio form). */
    spring: {
        travel: {
            duration: motionTokens.spring.travel.durationMs,
            dampingRatio: motionTokens.spring.travel.dampingRatio,
        },
    },
    easing: {
        standard: standardEasing,
        exit: Easing.bezier(0.4, 0, 1, 1),
        stageCamera: Easing.bezier(0.22, 0.82, 0.2, 1),
        linear: Easing.linear,
    },
    // Web layout animations recognize named easings, not the anonymous
    // function returned by a Bézier factory. Timing worklets keep the curve.
    layoutEasing: {
        standard: Platform.OS === 'web' ? Easing.ease : standardEasing.factory(),
    },
} as const;
