import { Easing } from 'react-native';

/**
 * Control points of the app's one timing curve.
 *
 * Named separately because the curve has to be built twice — once from React Native's `Easing`
 * for the classic `Animated` API, once from Reanimated's worklet `Easing` in
 * `reanimatedMotionTokens.ts`. Restating the four numbers in both places is how they drift, so
 * both build from this.
 *
 * There is deliberately only one. `easing.emphasized` used to sit beside `standard` as a second
 * name for the identical `bezier(0.2, 0, 0, 1)` — a vocabulary that promised a distinction it
 * never made. Physical motion in this app comes from `motionSprings.ts`; timing curves are for
 * opacity, where a single decelerating curve is the whole requirement.
 */
export const MOTION_STANDARD_BEZIER = [0.2, 0, 0, 1] as const;

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
        standard: Easing.bezier(...MOTION_STANDARD_BEZIER),
        linear: Easing.linear,
    },
} as const;
