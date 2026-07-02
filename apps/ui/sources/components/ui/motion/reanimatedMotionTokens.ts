import { Easing } from 'react-native-reanimated';

import { motionTokens } from './motionTokens';

export const reanimatedMotionTokens = {
    durationMs: motionTokens.durationMs,
    easing: {
        standard: Easing.bezier(0.2, 0, 0, 1),
        emphasized: Easing.bezier(0.2, 0, 0, 1),
        linear: Easing.linear,
    },
} as const;
