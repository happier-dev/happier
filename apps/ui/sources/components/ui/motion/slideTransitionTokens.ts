import { createSpringConfigResolver, type SpringPhysics } from './motionSprings';

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
 *
 * These two are the app's only springs outside the role vocabulary in `motionSprings.ts`, kept
 * because their numbers are a tuned visual signature rather than a role. What they do NOT keep is
 * their own reduced-motion behaviour: the spring is reachable only through
 * `resolveSlideTransitionSpring`, which stamps the policy through the same owner every other
 * spring uses.
 */
export type SlideTransitionPreset = 'soft' | 'compact';

export type SlideTransitionPresetTokens = Readonly<{
    /** Translation distance (px) used by the layer-style helper for non-current layers at progress=0. */
    translatePx: number;
    /** Peak blur (px on web). The blur layer scales this for native intensity. 0 disables blur entirely. */
    maxBlurPx: number;
    /** Multiplier applied when mapping web blurPx → native BlurView intensity (capped at 100). */
    nativeBlurIntensityScale: number;
}>;

export const slideTransitionTokens: Readonly<Record<SlideTransitionPreset, SlideTransitionPresetTokens>> = {
    soft: {
        translatePx: 32,
        maxBlurPx: 12,
        nativeBlurIntensityScale: 3,
    },
    compact: {
        translatePx: 16,
        maxBlurPx: 6,
        nativeBlurIntensityScale: 3,
    },
} as const;

const SLIDE_TRANSITION_SPRING_PHYSICS = {
    soft: { stiffness: 140, damping: 18, mass: 0.9 },
    compact: { stiffness: 220, damping: 24, mass: 0.7 },
} as const satisfies Record<SlideTransitionPreset, SpringPhysics>;

// A slide is travel across the screen — the textbook case reduced motion asks to remove. Both
// presets therefore land instantly, exactly like every vestibular role in `motionSprings.ts`.
const SLIDE_TRANSITION_REDUCED_MOTION_FALLBACKS = {
    soft: 'instant',
    compact: 'instant',
} as const;

/**
 * The slide spring for a preset, already carrying its reduced-motion policy.
 *
 * Built by the shared resolver factory rather than assembled here, so these two presets cannot
 * develop their own answer to freezing, config identity, or what reduced motion means.
 *
 * `reducedMotion` is the caller's EFFECTIVE state (`props.reducedMotion ?? the preference store`),
 * never the raw device setting: both adapters already honour that override on every branch they
 * own, and the library default (`ReduceMotion.System`) ignored it.
 */
export const resolveSlideTransitionSpring = createSpringConfigResolver(
    SLIDE_TRANSITION_SPRING_PHYSICS,
    SLIDE_TRANSITION_REDUCED_MOTION_FALLBACKS,
);
