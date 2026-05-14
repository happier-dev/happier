import { type WithSpringConfig } from 'react-native-reanimated';

/**
 * Tuning tokens for the unified slide transition primitives
 * (`SlideTransitionFrame` + adapters).
 *
 * Two presets share one Reanimated pipeline:
 *
 *   - `'soft'`: full-screen carousel (StoryDeck/onboarding/release notes). Larger
 *     translation distance, larger blur peak, looser spring. Premium signature for
 *     once-per-onboarding surfaces.
 *
 *   - `'compact'`: popover-friendly (SelectionList step transitions). Smaller
 *     translation distance, smaller blur peak (only used if `blur` is enabled by the
 *     caller — SelectionList opts out of blur entirely), tighter/quicker spring for
 *     frequent stepping.
 *
 * Constants are tuned in Phase 1A.11 visual QA against the reference screenshots.
 */
export type SlideTransitionPreset = 'soft' | 'compact';

export type SlideTransitionPresetTokens = Readonly<{
    /** Translation distance (px) used by the layer-style helper for non-current layers at progress=0. */
    translatePx: number;
    /** Peak blur (px on web). The blur layer scales this for native intensity. 0 disables blur entirely. */
    maxBlurPx: number;
    /** Multiplier applied when mapping web blurPx → native BlurView intensity (capped at 100). */
    nativeBlurIntensityScale: number;
    /** Spring config for adapters (`SlideTransitionSwitch`, `StoryDeckSlideTransition`). */
    spring: WithSpringConfig;
}>;

export const slideTransitionTokens: Readonly<Record<SlideTransitionPreset, SlideTransitionPresetTokens>> = {
    soft: {
        translatePx: 32,
        maxBlurPx: 12,
        nativeBlurIntensityScale: 3,
        spring: { damping: 18, stiffness: 140, mass: 0.9 },
    },
    compact: {
        translatePx: 16,
        maxBlurPx: 6,
        nativeBlurIntensityScale: 3,
        spring: { damping: 24, stiffness: 220, mass: 0.7 },
    },
} as const;
