import { Easing } from 'react-native';

export const motionTokens = {
    durationMs: {
        instant: 0,
        fast: 140,
        base: 220,
        slow: 320,
    },
    overlay: {
        popover: {
            enterMs: 140,
            exitMs: 120,
            fromScale: 0.96,
            fromDistance: 8,
        },
        modal: {
            enterMs: 200,
            exitMs: 160,
            fromScale: 0.985,
            fromTranslateY: 10,
            backdropMaxOpacity: 0.5,
        },
    },
    easing: {
        standard: Easing.bezier(0.2, 0, 0, 1),
        emphasized: Easing.bezier(0.2, 0, 0, 1),
        linear: Easing.linear,
    },
} as const;
