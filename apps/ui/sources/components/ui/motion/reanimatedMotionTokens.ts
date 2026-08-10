import { Easing } from 'react-native-reanimated';

import { MOTION_STANDARD_BEZIER, motionTokens } from './motionTokens';

/**
 * The same vocabulary as `motionTokens`, built with Reanimated's worklet-safe `Easing` so it can
 * cross to the UI thread. The curve is not restated here — it is built from the shared control
 * points so the two modules cannot drift apart.
 */
export const reanimatedMotionTokens = {
    durationMs: motionTokens.durationMs,
    easing: {
        standard: Easing.bezier(...MOTION_STANDARD_BEZIER),
        linear: Easing.linear,
    },
} as const;
