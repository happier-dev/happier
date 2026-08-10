import { Easing } from 'react-native-reanimated';

import { MOTION_STANDARD_BEZIER, motionTokens } from './motionTokens';

/**
 * The same vocabulary as `motionTokens`, built with Reanimated's worklet-safe `Easing` so it can
 * cross to the UI thread. The curve is not restated here — it is built from the shared control
 * points so the two modules cannot drift apart.
 *
 * The curves are built on FIRST READ, for the same reason `createSpringConfigResolver` builds its
 * tables lazily: `Easing.bezier(...)` is a call into the animation runtime, and running it during
 * module evaluation meant that merely IMPORTING this file reached into that runtime. That was
 * survivable while the only consumers were two components that animate — but the
 * `components/ui/motion` barrel now re-exports `StatusTransition`, which imports this, so every
 * consumer of the barrel evaluated it whether or not anything on screen moved. Under Vitest that
 * runtime is a mock, and the suites that narrow it failed at collection.
 *
 * Each curve is memoized, so a caller still gets one stable object for the process — Reanimated
 * compares easing identity when it decides whether a timing config changed.
 */
let standardEasing: ReturnType<typeof Easing.bezier> | null = null;
let linearEasing: typeof Easing.linear | null = null;

export const reanimatedMotionTokens = {
    durationMs: motionTokens.durationMs,
    easing: {
        get standard(): ReturnType<typeof Easing.bezier> {
            return (standardEasing ??= Easing.bezier(...MOTION_STANDARD_BEZIER));
        },
        get linear(): typeof Easing.linear {
            return (linearEasing ??= Easing.linear);
        },
    },
} as const;
