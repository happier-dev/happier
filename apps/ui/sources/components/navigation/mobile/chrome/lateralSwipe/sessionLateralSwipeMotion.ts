/**
 * The physics of the cockpit's lateral session swipe, kept as plain worklet-safe
 * arithmetic so both the gesture worklets and a node test read the same rule.
 *
 * `progress` is the single value the whole feature is expressed in: -1..1, where
 * negative travels toward the NEXT session (a right-to-left drag, matching the
 * documented gesture) and positive toward the PREVIOUS one. The capsule translate,
 * the tab-row dim and the readout fade are all derived from it.
 */

import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';

/**
 * Fraction of finger travel the capsule actually moves. Direct manipulation stays
 * attached to the finger, but at reduced gain: the capsule is a readout being
 * nudged, not a card being thrown, and full-gain travel would push it into the
 * screen gutter it is centred in.
 */
export const SESSION_LATERAL_SWIPE_TRAVEL_GAIN = 0.35;

/** Release distance that commits, and the divisor that maps travel onto `progress`. */
export const SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX = 72;

/** Release speed that commits a shorter drag, so a confident flick does not need the full distance. */
export const SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S = 520;

/** A flick still has to have gone somewhere; below this the release is a tap that wobbled. */
const SESSION_LATERAL_SWIPE_MIN_FLICK_DISTANCE_PX = 12;

/**
 * Horizontal activation bound. Deliberately wider than the 10px used by
 * `StoryDeckSlideTransition`: the cockpit tabs carry `hitSlop: 8`, so a tap that
 * lands slightly off-centre must never arm the pan and steal the tab press.
 */
export const SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX = 12;

/**
 * System-owned edge strips, expressed as NEGATIVE hitSlop insets so the pan simply
 * does not exist there. These are device-measured values, not derived ones:
 *
 * - iOS owns the LEADING edge for the interactive pop gesture. UIKit wins that
 *   arbitration silently and RNGH cannot be told about a UIKit recognizer, so the
 *   only reliable answer is to stay out of the strip. ~50pt is the measured safe start.
 * - Android owns BOTH edges for system back, and claims them after the app has
 *   already seen the touch down — hence the trailing inset too, plus first-class
 *   cancellation handling in the gesture itself.
 */
const SESSION_LATERAL_SWIPE_EDGE_LEAD_PX = 50;
const SESSION_LATERAL_SWIPE_EDGE_TRAIL_PX = 32;

export type SessionLateralSwipeEdgeHitSlop = Readonly<{ left: number; right: number }>;

export function resolveSessionLateralSwipeEdgeHitSlop(os: string): SessionLateralSwipeEdgeHitSlop {
    if (os === 'android') {
        return { left: -SESSION_LATERAL_SWIPE_EDGE_LEAD_PX, right: -SESSION_LATERAL_SWIPE_EDGE_TRAIL_PX };
    }
    return { left: -SESSION_LATERAL_SWIPE_EDGE_LEAD_PX, right: 0 };
}

/**
 * Progressive resistance at an end of the order. Asymptotic rather than clamped:
 * the surface keeps answering the finger, each further pixel buys less travel, and
 * it can never reach the boundary it is being held back from.
 *
 * Unit-agnostic on purpose — it takes travel measured past the boundary in whatever
 * unit the caller works in (commit distances here, rows for the picker's vertical
 * axis) and returns the resisted travel in that same unit, so both axes of the
 * gesture rubber-band on one curve instead of two.
 */
const EDGE_RESISTANCE_CEILING = 0.5;
const EDGE_RESISTANCE_FALLOFF = 3;

export function resolveSessionLateralSwipeEdgeResistance(raw: number): number {
    'worklet';
    const magnitude = raw < 0 ? -raw : raw;
    const sign = raw < 0 ? -1 : 1;
    return sign * EDGE_RESISTANCE_CEILING * (magnitude / (1 + magnitude * EDGE_RESISTANCE_FALLOFF));
}

export function resolveSessionLateralSwipeProgress(params: Readonly<{
    translationX: number;
    canStepPrevious: boolean;
    canStepNext: boolean;
}>): number {
    'worklet';
    const translationX = typeof params.translationX === 'number' ? params.translationX : 0;
    const raw = translationX / SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX;
    const travellingToPrevious = raw > 0;
    const hasNeighbour = travellingToPrevious ? params.canStepPrevious : params.canStepNext;
    if (!hasNeighbour) {
        return resolveSessionLateralSwipeEdgeResistance(raw);
    }
    if (raw > 1) return 1;
    if (raw < -1) return -1;
    return raw;
}

/**
 * The capsule morph, expressed once so the readout and the tab row it covers cannot
 * develop two fade curves. Both are driven by the same `progress`: by half the commit
 * distance the readout has fully taken over and the row is a ghost of where you were.
 *
 * The picker is the morph's SECOND input, and it is a floor rather than a separate
 * curve. Once the picker is open the capsule is its selection window, so the readout
 * must be fully present however short the sideways drag that armed it was — otherwise a
 * 12px flick followed by a lift leaves the destination half-transparent while the user
 * is actively choosing it. Defaulting to 0 keeps every caller that has no second axis.
 */
const READOUT_FULL_AT_PROGRESS = 0.5;
const TAB_ROW_DIMMED_OPACITY = 0.1;

function resolveMorphRamp(progress: number, browseProgress: number): number {
    'worklet';
    const travelled = progress < 0 ? -progress : progress;
    const ramped = travelled / READOUT_FULL_AT_PROGRESS;
    const capped = ramped > 1 ? 1 : ramped;
    const floor = browseProgress > 1 ? 1 : browseProgress < 0 ? 0 : browseProgress;
    return capped > floor ? capped : floor;
}

export function resolveSessionLateralSwipeReadoutOpacity(progress: number, browseProgress = 0): number {
    'worklet';
    return resolveMorphRamp(progress, browseProgress);
}

export function resolveSessionLateralSwipeTabRowOpacity(progress: number, browseProgress = 0): number {
    'worklet';
    return 1 - resolveMorphRamp(progress, browseProgress) * (1 - TAB_ROW_DIMMED_OPACITY);
}

/**
 * How the session content answers the swipe.
 *
 * The incoming session cannot be rendered during the drag — it is a whole session
 * tree with its own navigator, a cold transcript derivation and a decrypt round-trip
 * — so this is deliberately NOT a pager. The current session recedes instead, and on
 * commit it arrives from the extreme, which puts the remount every session switch
 * already pays behind a motion instead of in front of a blank screen.
 *
 * Transform and opacity only. NO BLUR: `SlideTransitionBlurLayer` animates a BlurView's
 * intensity every frame, which is tuned for small onboarding surfaces and is a real GPU
 * cost across a live transcript. Do not reuse it here.
 */
export const SESSION_LATERAL_SWIPE_CONTENT_TRAVEL_PX = 24;
/** Floors opacity at 0.45: the session dims, it never blanks over hydrated content. */
const CONTENT_RECEDE_OPACITY_DEPTH = 0.55;
const CONTENT_RECEDE_SCALE_DEPTH = 0.015;

export type SessionLateralSwipeContentMotion = Readonly<{
    translateX: number;
    scale: number;
    opacity: number;
}>;

export function resolveSessionLateralSwipeContentMotion(params: Readonly<{
    progress: number;
    reducedMotion: boolean;
}>): SessionLateralSwipeContentMotion {
    'worklet';
    const progress = typeof params.progress === 'number' ? params.progress : 0;
    const travelled = progress < 0 ? -progress : progress;
    const opacity = 1 - CONTENT_RECEDE_OPACITY_DEPTH * travelled;
    // Reduced motion keeps the depth cue and drops the movement: the session still
    // changes, it simply does not travel.
    if (params.reducedMotion) {
        return { translateX: 0, scale: 1, opacity };
    }
    return {
        translateX: SESSION_LATERAL_SWIPE_CONTENT_TRAVEL_PX * progress,
        scale: 1 - CONTENT_RECEDE_SCALE_DEPTH * travelled,
        opacity,
    };
}

/**
 * The commit decision, taken at release from distance OR velocity — never from
 * release position alone, so a short confident flick lands the same way a long
 * deliberate drag does. Returns null for "snap back": below threshold, dead
 * centre, a flick that reversed, or a direction with no neighbour.
 */
export function resolveSessionLateralSwipeCommitDirection(params: Readonly<{
    translationX: number;
    velocityX: number;
    canStepPrevious: boolean;
    canStepNext: boolean;
}>): SessionNavigationDirection | null {
    'worklet';
    const translationX = typeof params.translationX === 'number' ? params.translationX : 0;
    const velocityX = typeof params.velocityX === 'number' ? params.velocityX : 0;
    if (translationX === 0) return null;

    const direction: SessionNavigationDirection = translationX > 0 ? 'previous' : 'next';
    const hasNeighbour = direction === 'previous' ? params.canStepPrevious : params.canStepNext;
    if (!hasNeighbour) return null;

    const distance = translationX < 0 ? -translationX : translationX;
    if (distance >= SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX) return direction;

    const sameSign = translationX > 0 ? velocityX > 0 : velocityX < 0;
    const speed = velocityX < 0 ? -velocityX : velocityX;
    if (
        sameSign
        && speed >= SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S
        && distance >= SESSION_LATERAL_SWIPE_MIN_FLICK_DISTANCE_PX
    ) {
        return direction;
    }

    return null;
}
