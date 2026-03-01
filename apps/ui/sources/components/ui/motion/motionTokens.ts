import { Easing } from 'react-native';

export const motionTokens = {
    durationMs: {
        instant: 0,
        fast: 140,
        base: 220,
        slow: 320,
    },
    easing: {
        standard: Easing.bezier(0.2, 0, 0, 1),
        emphasized: Easing.bezier(0.2, 0, 0, 1),
        linear: Easing.linear,
    },
} as const;
