/**
 * The two-axis state machine behind the cockpit's lateral session gesture.
 *
 * The horizontal axis steers to the immediate neighbour; once a direction is locked,
 * lifting the finger opens a picker of the sessions FURTHER that way and scrubbing
 * up/down selects among them. Scrubbing deliberately does not navigate — it only moves
 * which session the capsule reads out — because a session switch remounts a transcript,
 * and that cost is paid exactly once, on release.
 *
 * This module owns the vertical axis end to end — the decision AND its geometry — with
 * no React and no store. `sessionLateralSwipeMotion` remains the owner of the horizontal
 * pixels (capsule travel, opacity ramps, content recede) and of the horizontal commit
 * rule; the release resolver here delegates to it rather than re-deciding it, so a flick
 * still commits the way it does today. The row geometry lives HERE rather than there
 * because it is measured in the row pitch this module defines, and splitting the two
 * would make the pixel owner import from the decision owner that already imports it.
 * Everything is plain worklet-safe arithmetic, so a node test and the gesture worklet
 * read the same rule.
 */

import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';

import {
    SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
    resolveSessionLateralSwipeCommitDirection,
    resolveSessionLateralSwipeEdgeResistance,
} from './sessionLateralSwipeMotion';


/**
 * Worklet-safe primitives, defined ABOVE every worklet that calls them — and that order is
 * load-bearing, not tidiness.
 *
 * A worklet captures the identifiers it references when it is BUILT, and Reanimated's plugin
 * rewrites a hoisted `function` declaration into a non-hoisted assignment. So a worklet
 * defined earlier in the file captures `undefined` for a helper declared later, and the
 * failure only appears on the UI thread — as `toFiniteNumber is not a function`, thrown from
 * inside `useAnimatedStyle`, which is what shipped once a geometry worklet was added above
 * these. Vitest never runs that plugin, so no host test can catch it: keep them at the top.
 */
function toFiniteNumber(value: number): number {
    'worklet';
    return typeof value === 'number' && value === value ? value : 0;
}

function clampUnit(value: number): number {
    'worklet';
    if (value <= 0) return 0;
    return value > 1 ? 1 : value;
}

/**
 * Upward travel, past horizontal activation, that opens the picker. Comfortably clear
 * of the vertical wander a horizontal drag carries — the pan has no vertical failure
 * bound at all once it has activated, so this threshold is the only thing separating a
 * sloppy sideways stroke from the intent to lift — while staying well inside one row.
 * Device-tunable.
 */
export const SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX = 28;

/**
 * The pitch: upward travel that advances the selection by one session, and the height of
 * a row. Constant the whole way up the column — one row is one pitch wherever it sits, so
 * the row the finger is over is the row the eye is over, at any depth.
 *
 * Tightened from 44 to buy depth: the pitch is the exchange rate between arm and reach, so
 * every pixel off it is a row further down the order for the same arc. 36 still clears a
 * glyph beside a 14pt title without the rows touching, which is the floor a row of session
 * names actually has. Device-tunable.
 */
export const SESSION_LATERAL_PICKER_ROW_PITCH_PX = 36;

/**
 * How deep into the order a scrub can reach. NOT how much is painted — see the window
 * below; reach and visibility are two different budgets and were one constant until they
 * disagreed.
 *
 * THE REACH IS FINGER TRAVEL, and at a constant pitch it is exactly linear: reaching the
 * Nth row costs `BROWSE_THRESHOLD_PX + N * ROW_PITCH_PX` of upward travel, so eighteen rows
 * is 28 + 18 * 36 = 676px of upward arc.
 *
 * That is deliberately past comfortable, and it costs nothing to offer: the deep rows are
 * mounted but unpainted, so the only thing standing between the thumb and the far end of
 * the order is how far someone cares to stretch. The rubber-band at the end of the loaded
 * order is what stops the gesture in practice. Device-tunable.
 */
export const SESSION_LATERAL_PICKER_REACH_ROWS = 18;

/**
 * How many rows the column actually paints above the capsule, and so how tall it reads.
 *
 * Bounded by ATTENTION, not by reach. Only the nearest rows are a decision — beyond them
 * the list is not something you read, it is something you feel your way along, and the one
 * fact worth carrying is "there is more up there". Painting the whole reach at one opacity
 * said the opposite: eighteen equally-solid rows are a wall, and a wall has no direction.
 *
 * So the window is short and it FADES with distance, and it is anchored to the capsule
 * rather than to the list — the list slides through it. That is what makes the reveal:
 * scrubbing up brightens every row as it descends and brings the next one in at the top,
 * so the depth is discovered a row at a time instead of being dumped at once.
 *
 * Five rows and 5 * 36 = 180px is the whole painted footprint, which is why the reach can
 * be as deep as the arm allows without the column ever running off a small screen.
 */
export const SESSION_LATERAL_PICKER_VISIBLE_WINDOW_ROWS = 5;

/**
 * How far into the locked direction the picker can reach: the visible column, plus the one
 * row above it that a scrub pulls down into view rather than popping in.
 *
 * It is a real ceiling, not a virtualisation window — every reachable row is mounted,
 * which is what lets the list be positioned entirely from worklets with no per-frame
 * recycling and no one-frame desync. The order itself is usually the shorter limit; the
 * rubber-band at the end of the loaded pages is what says so.
 *
 * A plain expression over constants, never a call. Everything that computes geometry here
 * is a `'worklet'`, and invoking one at module scope reaches into the animation runtime
 * before anything has asked for an animation — the mistake `motionSprings.ts` and
 * `SessionCockpitChromeRegistry.tsx` each record, and which here took the whole registry
 * down on device with `Cannot read property … of undefined`, because a module that throws
 * while evaluating leaves its namespace undefined for every importer.
 */
export const SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES = SESSION_LATERAL_PICKER_REACH_ROWS + 1;

/**
 * How far the column starts BELOW its resting place, so the picker rises out of the
 * capsule instead of switching on. Small enough to read as emergence rather than travel.
 */
const SESSION_LATERAL_PICKER_OPEN_LIFT_PX = 8;

/** Below two further sessions there is nothing to pick between, so the picker stays shut. */
const MINIMUM_BROWSABLE_ENTRIES = 2;

export type SessionLateralPickerPhase = 'idle' | 'steering' | 'browsing';

export type SessionLateralPickerState = Readonly<{
    phase: SessionLateralPickerPhase;
    /** Locked at activation and never re-derived while the finger is down. */
    direction: SessionNavigationDirection | null;
    /** 1-based distance into the locked direction; 1 is the immediate neighbour, 0 is nothing selectable. */
    index: number;
    /** 0 at the browse threshold, 1 by the first full row — drives the scrim and the row dissolve. */
    browseProgress: number;
    /** Continuous, resistance-applied row travel from the immediate neighbour, for positioning the list. */
    rowOffset: number;
}>;

const IDLE_STATE: SessionLateralPickerState = {
    phase: 'idle',
    direction: null,
    index: 0,
    browseProgress: 0,
    rowOffset: 0,
};


/**
 * Where the picker list sits, in rows past the immediate neighbour, including the
 * rubber-band past the last entry. Exposed on its own so a caller positioning rows
 * per frame does not have to re-derive the resistance the state machine already owns.
 */
export function resolveSessionLateralPickerRowOffset(params: Readonly<{
    translationY: number;
    availableInDirection: number;
}>): number {
    'worklet';
    // NEGATIVE translationY is upward in RNGH, and up is what opens the picker.
    const upwardTravel = -toFiniteNumber(params.translationY);
    const browseTravel = upwardTravel - SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX;
    if (browseTravel <= 0) return 0;

    const rows = browseTravel / SESSION_LATERAL_PICKER_ROW_PITCH_PX;
    const lastRow = Math.max(0, toFiniteNumber(params.availableInDirection) - 1);
    if (rows <= lastRow) return rows;
    // Past the last loaded entry the finger still moves the list, in ROWS — the same unit
    // the whole vertical axis is expressed in, and the same resistance curve the
    // horizontal axis rubber-bands on, so there is one give in the gesture rather than two.
    return lastRow + resolveSessionLateralSwipeEdgeResistance(rows - lastRow);
}

export function resolveSessionLateralPickerState(params: Readonly<{
    translationX: number;
    translationY: number;
    availableInDirection: number;
    lockedDirection?: SessionNavigationDirection | null;
}>): SessionLateralPickerState {
    'worklet';
    const translationX = toFiniteNumber(params.translationX);
    const travelled = translationX < 0 ? -translationX : translationX;
    // Activation is horizontal-only, which is what keeps taps and vertical intent
    // untouched: no amount of vertical travel can arm this gesture on its own.
    // The CURRENT sign wins whenever there is one to read; the lock only bridges the
    // neutral band where there is not.
    //
    // The precedence used to be the other way round — lock first, sign never again — to stop
    // the direction flickering at the zero crossing. It stopped the flicker and broke the
    // gesture: one drag could only ever browse the direction it happened to start in, so
    // coming back through the middle and deliberately swiping the other way kept listing the
    // first direction's sessions, and a few accidental pixels at touch-down silently decided
    // the whole gesture. Reading the sign outside the band and holding the lock inside it
    // gives the anti-flicker guarantee where it was actually needed, and gives a deliberate
    // reversal back to the user.
    const direction: SessionNavigationDirection | null =
        travelled >= SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX
            ? (translationX > 0 ? 'previous' : 'next')
            : (params.lockedDirection ?? null);
    if (!direction) return IDLE_STATE;

    const availableInDirection = Math.max(0, Math.floor(toFiniteNumber(params.availableInDirection)));
    const steering: SessionLateralPickerState = {
        phase: 'steering',
        direction,
        index: availableInDirection >= 1 ? 1 : 0,
        browseProgress: 0,
        rowOffset: 0,
    };
    if (availableInDirection < MINIMUM_BROWSABLE_ENTRIES) return steering;

    const upwardTravel = -toFiniteNumber(params.translationY);
    if (upwardTravel < SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX) return steering;

    const rowOffset = resolveSessionLateralPickerRowOffset({
        translationY: params.translationY,
        availableInDirection,
    });
    const browseTravel = upwardTravel - SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX;
    const opening = browseTravel / SESSION_LATERAL_PICKER_ROW_PITCH_PX;
    return {
        phase: 'browsing',
        direction,
        index: Math.min(availableInDirection, 1 + Math.floor(rowOffset)),
        browseProgress: opening > 1 ? 1 : opening,
        rowOffset,
    };
}

/**
 * The gesture-facing entry point: one frame in, the whole two-axis state out.
 *
 * It exists because `resolveSessionLateralPickerState` decides the direction but needs a
 * count that depends on it, which leaves a caller holding both counts unable to choose
 * one before asking. Pairing them is itself a decision, and doing it at each call site
 * would put the same rule in the pan's `onUpdate` and its `onEnd` — where the second
 * copy would only be exercised by a flick that ends before it ever updates. So the
 * pairing lives here, once, and delegates for everything else.
 */
export function resolveSessionLateralPickerFrame(params: Readonly<{
    translationX: number;
    translationY: number;
    availablePrevious: number;
    availableNext: number;
    lockedDirection?: SessionNavigationDirection | null;
}>): SessionLateralPickerState {
    'worklet';
    // The direction is asked for on its own first, with no count, because at this point
    // there is no honest answer to "how many that way".
    const direction = resolveSessionLateralPickerState({
        translationX: params.translationX,
        translationY: 0,
        availableInDirection: 0,
        lockedDirection: params.lockedDirection ?? null,
    }).direction;
    if (!direction) return IDLE_STATE;

    return resolveSessionLateralPickerState({
        translationX: params.translationX,
        translationY: params.translationY,
        availableInDirection: direction === 'previous' ? params.availablePrevious : params.availableNext,
        lockedDirection: direction,
    });
}

export type SessionLateralPickerCommit = Readonly<{
    direction: SessionNavigationDirection;
    index: number;
}>;

/**
 * The single decision taken at release. `cancelled` carries RNGH's own `success: false`
 * — Android claims its edge strips after the app has already seen the touch down, and a
 * gesture taken away mid-drag must never land a navigation.
 *
 * Steering defers to the horizontal owner, so distance, flick velocity and the
 * finger-crossed-back-over-the-origin case all keep exactly one answer. Browsing carries
 * no distance requirement: the user has visibly selected a row, and asking them to also
 * hold a horizontal offset would make the selection they can see refuse to land.
 */
export function resolveSessionLateralPickerCommit(params: Readonly<{
    state: SessionLateralPickerState;
    translationX: number;
    velocityX: number;
    cancelled?: boolean;
}>): SessionLateralPickerCommit | null {
    'worklet';
    const { state } = params;
    if (params.cancelled === true) return null;
    if (state.phase === 'idle' || !state.direction || state.index < 1) return null;

    if (state.phase === 'browsing') {
        return { direction: state.direction, index: state.index };
    }

    const hasNeighbour = state.index >= 1;
    const direction = resolveSessionLateralSwipeCommitDirection({
        translationX: params.translationX,
        velocityX: params.velocityX,
        canStepPrevious: hasNeighbour && state.direction === 'previous',
        canStepNext: hasNeighbour && state.direction === 'next',
    });
    return direction ? { direction, index: 1 } : null;
}

export type SessionLateralPickerRowMotion = Readonly<{ translateY: number; opacity: number }>;


/**
 * Where one picker row sits and how solid it is, for a list laid out against the
 * capsule's TOP edge — so `translateY` is negative going up and 0 is the capsule itself.
 *
 * The whole surface is expressed here rather than as per-row state, because there is only
 * one thing to know: how far the list has been scrubbed. A row's place is its distance
 * from the selection, one constant pitch per row — so the column is rigid in screen space
 * and the whole list slides through it. That is what makes the capsule read as the
 * picker's selection window instead of as a separate readout that happens to agree: a row
 * descends into it over a full pitch, dissolves exactly as it arrives, and the capsule is
 * already showing that session when it gets there. However deep the scrub, the arrival
 * looks the same.
 *
 * Both dissolves are one row wide, and they are the same expression at both ends of the
 * column: at the bottom a row must be gone exactly as it lands in the capsule, and at the
 * top the list has to end by fading rather than by meeting an edge — `OverlayScrim`'s
 * frost band only reaches 88pt and the column stands taller than that.
 */
export function resolveSessionLateralPickerRowMotion(params: Readonly<{
    /** 1-based entry index into the locked direction; 1 is the immediate neighbour. */
    entryIndex: number;
    rowOffset: number;
    browseProgress: number;
    reducedMotion: boolean;
}>): SessionLateralPickerRowMotion {
    'worklet';
    const browseProgress = clampUnit(toFiniteNumber(params.browseProgress));
    // Rows above the capsule, in row units. Fractional, and negative once the row has
    // descended past the capsule's top edge.
    const slot = toFiniteNumber(params.entryIndex) - 1 - toFiniteNumber(params.rowOffset);
    // Reduced motion keeps the shift — that shift IS the selection — and drops only the
    // decorative rise, so the picker still opens and still selects without travelling.
    const lift = params.reducedMotion ? 0 : (1 - browseProgress) * SESSION_LATERAL_PICKER_OPEN_LIFT_PX;
    // Two fades, in opposite directions, and the row is whatever both allow.
    //
    // `clampUnit(slot)` is the handoff at the BOTTOM: a row dissolves over its last pitch
    // of descent and is gone exactly as the capsule starts naming it, so the two surfaces
    // never show the same session twice.
    //
    // The second is DEPTH. A linear ramp across the window, so the nearest row is fully
    // present, each one behind it is dimmer by a fixed step, and the row past the window is
    // exactly zero rather than faint — the difference between a list that recedes and a
    // list that is merely cut off. It reaches zero one row past the window's last visible
    // row, which is what keeps the arriving row a fade-in rather than a pop.
    const depth = clampUnit(
        (SESSION_LATERAL_PICKER_VISIBLE_WINDOW_ROWS + 1 - slot) / SESSION_LATERAL_PICKER_VISIBLE_WINDOW_ROWS,
    );
    return {
        translateY: -slot * SESSION_LATERAL_PICKER_ROW_PITCH_PX + lift,
        opacity: clampUnit(slot) * depth * browseProgress,
    };
}
