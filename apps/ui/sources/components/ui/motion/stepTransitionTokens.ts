import { Easing } from 'react-native';

import { motionTokens } from './motionTokens';

/**
 * Shared timings for step/page transitions used by both `StoryDeck` and the
 * wizard step body. Centralized so the same polish lands in every paged surface.
 */
export const stepTransitionTokens = {
    durationMs: {
        enter: motionTokens.durationMs.base,
        exit: motionTokens.durationMs.fast,
    },
    translatePx: 12,
    easing: motionTokens.easing.standard,
    easingExit: Easing.bezier(0.4, 0, 1, 1),
    fromOpacity: 0,
    toOpacity: 1,
} as const;

export type StepTransitionTokens = typeof stepTransitionTokens;
