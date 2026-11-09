/**
 * The decisions behind the phone's session switcher, the one gesture surface on the session bar.
 *
 * Everything that moves sessions from the bar is one switcher with one row model (lab
 * `phone-nav2`, rounds 2b and 2c):
 *
 * - **Sideways** opens the switcher directional and pre-selected: left → right = next,
 *   right → left = previous. Letting go at once opens the raised row (today's quick swipe);
 *   keeping the finger down and moving up continues that way one row per step; one step down
 *   lands on Here and letting go stays.
 * - **Drag up** shows a ghost of the switcher that follows the finger and locks at
 *   `SESSION_SWITCHER_LOCK_PX`; after the lock the scrub is RELATIVE (one row per step from
 *   wherever the thumb is) with edge auto-scroll. One step below the first row is the bar, and
 *   letting go there stays.
 * - **Flick** up/down before the lock = next/previous.
 * - **Hold** and let go in place docks the same panel for tapping.
 *
 * Only the decisions live here — plain worklet-safe arithmetic, so a node test and the gesture
 * worklets read one rule. Rows are indexed nearest-first: `0` is the raised (nearest) row and
 * `-1` is "stay here" (the current row in the sideways panel, the bar in the vertical one).
 * Each gesture has its own setting; a setting that is off removes its gesture, never more.
 */

import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { motionTokens } from '@/components/ui/motion/motionTokens';

// Worklet-safe primitives stay ABOVE every worklet that uses them: Reanimated's plugin turns a
// hoisted `function` into a non-hoisted assignment, so a worklet built earlier would capture
// `undefined` — a failure that only appears on the UI thread (see the import-isolation test).
function finite(value: number): number {
    'worklet';
    return typeof value === 'number' && value === value ? value : 0;
}

function abs(value: number): number {
    'worklet';
    return value < 0 ? -value : value;
}

/** Movement before the bar's gesture claims the touch. Wider than a tab's hit-area reach, so a sloppy tap never arms it. */
export const SESSION_SWITCHER_ACTIVATION_PX = motionTokens.gesture.slopPx;
/** Upward travel at which the ghost locks into the scrubber (≈⅕ of the space above the bar on a 390×844 phone). Device-tunable. */
export const SESSION_SWITCHER_LOCK_PX = 120;
/** The bar rises at this fraction of the finger, so after the lock the thumb lands on the first row with room below it. */
export const SESSION_SWITCHER_LIFT_GAIN = 0.6;
/** Thumb travel per row once the scrub is relative. Device-tunable. */
export const SESSION_SWITCHER_STEP_PX = 22;
/** Height of the band at the list's ends where holding keeps stepping. Device-tunable. */
export const SESSION_SWITCHER_EDGE_ZONE_PX = 64;
const AUTO_SCROLL_MIN_ROWS_PER_S = 4;
const AUTO_SCROLL_MAX_ROWS_PER_S = 18;
/** How long a still finger rests on the bar before letting go docks the switcher. Device-tunable. */
export const SESSION_SWITCHER_HOLD_MS = 320;
/** How far a holding finger may wander and still count as still. */
export const SESSION_SWITCHER_HOLD_SLOP_PX = 10;
/** Today's sideways commit distance and speed; also an upward flick's distance. */
export const SESSION_SWITCHER_COMMIT_DISTANCE_PX = 72;
export const SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S = 520;
/** A flick still has to have gone somewhere; below this the release is a tap that wobbled. */
const MIN_FLICK_DISTANCE_PX = 12;
/** A flick down needs less: there is almost no room below the bar. */
const FLICK_DOWN_DISTANCE_PX = 36;

/**
 * System-owned edge strips, as NEGATIVE hitSlop so the bar's gesture does not exist there
 * (device-measured): iOS owns the leading ~50pt for the interactive pop; Android claims both
 * edges for system back after the app has seen the touch down.
 */
export function resolveSessionSwitcherEdgeHitSlop(os: string): Readonly<{ left: number; right: number }> {
    return os === 'android' ? { left: -50, right: -32 } : { left: -50, right: 0 };
}

export type SessionSwitcherGestureSettings = Readonly<{
    sideways: boolean;
    dragUp: boolean;
    flick: boolean;
    holdToDock: boolean;
}>;

/**
 * The gesture's phase. `held` = a still finger past the hold time (docks on release);
 * `side` = the directional panel; `lift` = the vertical ghost before the lock; `scrub` = locked;
 * `flick` = a vertical stroke that only resolves at release; `none` = the stroke is not ours.
 */
export type SessionSwitcherPhase = 'idle' | 'held' | 'side' | 'lift' | 'scrub' | 'flick' | 'none';

export type SessionSwitcherStart = Readonly<{
    phase: 'side' | 'lift' | 'flick' | 'none';
    direction?: SessionNavigationDirection;
}>;

/**
 * What a stroke that has just claimed the bar becomes. Sideways only while the bar does not
 * scroll its tools (a scrolling bar owns that axis) and never after a hold (a hold is a
 * decision to tap). Up is the ghost, or a flick when drag-up is off; down is only ever a flick.
 */
export function resolveSessionSwitcherStart(params: Readonly<{
    translationX: number;
    translationY: number;
    held: boolean;
    settings: SessionSwitcherGestureSettings;
    barScrolls: boolean;
}>): SessionSwitcherStart {
    'worklet';
    const x = finite(params.translationX);
    const y = finite(params.translationY);
    const { settings } = params;
    if (abs(x) >= SESSION_SWITCHER_ACTIVATION_PX && abs(x) > abs(y)) {
        if (params.held || params.barScrolls || !settings.sideways) return { phase: 'none' };
        return { phase: 'side', direction: x > 0 ? 'next' : 'previous' };
    }
    if (y <= -SESSION_SWITCHER_ACTIVATION_PX) {
        if (settings.dragUp) return { phase: 'lift' };
        return settings.flick && !params.held ? { phase: 'flick' } : { phase: 'none' };
    }
    if (y >= SESSION_SWITCHER_ACTIVATION_PX) {
        return settings.flick && !params.held ? { phase: 'flick' } : { phase: 'none' };
    }
    return { phase: 'none' };
}

/** How far the ghost has come: `progress` 0..1 toward the lock, and how far the bar has risen. */
export function resolveSessionSwitcherLift(upwardTravel: number): Readonly<{ progress: number; lift: number; locked: boolean }> {
    'worklet';
    const travel = finite(upwardTravel) > 0 ? finite(upwardTravel) : 0;
    const locked = travel >= SESSION_SWITCHER_LOCK_PX;
    const reach = locked ? SESSION_SWITCHER_LOCK_PX : travel;
    return { progress: reach / SESSION_SWITCHER_LOCK_PX, lift: reach * SESSION_SWITCHER_LIFT_GAIN, locked };
}

/**
 * The relative scrub: one row per step of thumb travel from the anchor, upward = further.
 * Past either end the anchor moves with the thumb, so reversing answers at once.
 */
export function resolveSessionSwitcherScrub(params: Readonly<{
    y: number;
    anchorY: number;
    anchorIndex: number;
    count: number;
    minIndex: number;
}>): Readonly<{ index: number; anchorY: number }> {
    'worklet';
    const y = finite(params.y);
    const maxIndex = params.count - 1;
    const index = params.anchorIndex + Math.round((finite(params.anchorY) - y) / SESSION_SWITCHER_STEP_PX);
    if (index > maxIndex && maxIndex >= params.minIndex) {
        return { index: maxIndex, anchorY: y + (maxIndex - params.anchorIndex) * SESSION_SWITCHER_STEP_PX };
    }
    if (index < params.minIndex) {
        return { index: params.minIndex, anchorY: y + (params.minIndex - params.anchorIndex) * SESSION_SWITCHER_STEP_PX };
    }
    return { index, anchorY: params.anchorY };
}

/**
 * Rows per second the list keeps stepping while the thumb holds near an end: positive = further
 * (the top zone), negative = back toward the bar (the bottom zone, only once the list has
 * scrolled). Faster the closer the thumb is to the edge; 0 in the middle.
 */
export function resolveSessionSwitcherAutoScrollRate(params: Readonly<{
    y: number;
    listTop: number;
    listBottom: number;
    index: number;
    minIndex: number;
    scrolled: boolean;
}>): number {
    'worklet';
    const y = finite(params.y);
    const span = AUTO_SCROLL_MAX_ROWS_PER_S - AUTO_SCROLL_MIN_ROWS_PER_S;
    const topEdge = finite(params.listTop) + SESSION_SWITCHER_EDGE_ZONE_PX;
    if (y < topEdge) {
        const closeness = Math.min(1, (topEdge - y) / SESSION_SWITCHER_EDGE_ZONE_PX);
        return AUTO_SCROLL_MIN_ROWS_PER_S + span * closeness;
    }
    const half = SESSION_SWITCHER_EDGE_ZONE_PX / 2;
    const bottom = finite(params.listBottom);
    if (params.scrolled && params.index > params.minIndex && y > bottom - half && y < bottom + 24) {
        const closeness = Math.min(1, (y - (bottom - half)) / (half + 24));
        return -(AUTO_SCROLL_MIN_ROWS_PER_S + span * closeness);
    }
    return 0;
}

export type SessionSwitcherRelease =
    | Readonly<{ kind: 'open'; index: number }>
    | Readonly<{ kind: 'flick'; direction: SessionNavigationDirection }>
    | Readonly<{ kind: 'dock' }>
    | Readonly<{ kind: 'cancel' }>;

const CANCEL: SessionSwitcherRelease = { kind: 'cancel' };

/** The single decision taken when the finger lifts. */
export function resolveSessionSwitcherRelease(params: Readonly<{
    phase: SessionSwitcherPhase;
    index: number;
    /** The selection moved by scrubbing: what the person can see lands without a distance requirement. */
    scrubbed: boolean;
    translationX: number;
    translationY: number;
    velocityX: number;
    velocityY: number;
    maxAbsTranslationX: number;
    flickEnabled: boolean;
    /** RNGH's `success: false`: a gesture the system took away never lands. */
    cancelled: boolean;
}>): SessionSwitcherRelease {
    'worklet';
    if (params.cancelled) return CANCEL;
    const x = finite(params.translationX);
    const y = finite(params.translationY);
    const vx = finite(params.velocityX);
    const vy = finite(params.velocityY);
    switch (params.phase) {
        case 'held':
            return { kind: 'dock' };
        case 'scrub':
            return params.index >= 0 ? { kind: 'open', index: params.index } : CANCEL;
        case 'lift':
            return params.flickEnabled && vy <= -SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S && -y >= MIN_FLICK_DISTANCE_PX
                ? { kind: 'flick', direction: 'next' }
                : CANCEL;
        case 'side': {
            if (params.index < 0) return CANCEL;
            const quick = params.scrubbed
                || finite(params.maxAbsTranslationX) >= SESSION_SWITCHER_COMMIT_DISTANCE_PX
                || (abs(vx) >= SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S && abs(x) >= MIN_FLICK_DISTANCE_PX && (x > 0) === (vx > 0));
            return quick ? { kind: 'open', index: params.index } : CANCEL;
        }
        case 'flick': {
            if (y < 0) {
                const up = -y;
                return up >= SESSION_SWITCHER_COMMIT_DISTANCE_PX
                    || (vy <= -SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S && up >= MIN_FLICK_DISTANCE_PX)
                    ? { kind: 'flick', direction: 'next' }
                    : CANCEL;
            }
            return y >= FLICK_DOWN_DISTANCE_PX
                || (vy >= SESSION_SWITCHER_COMMIT_VELOCITY_PX_PER_S && y >= MIN_FLICK_DISTANCE_PX)
                ? { kind: 'flick', direction: 'previous' }
                : CANCEL;
        }
        default:
            return CANCEL;
    }
}
