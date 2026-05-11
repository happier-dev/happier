import { Easing } from 'react-native';

export const softSlideTransitionTokens = {
    durationMs: {
        enter: 460,
        exit: 320,
    },
    blurPx: 10,
    nativeBlurIntensity: 34,
    translatePx: 18,
    easingCss: 'cubic-bezier(0.2, 0, 0, 1)',
    easing: Easing.bezier(0.2, 0, 0, 1),
    easingExit: Easing.bezier(0.4, 0, 1, 1),
} as const;
