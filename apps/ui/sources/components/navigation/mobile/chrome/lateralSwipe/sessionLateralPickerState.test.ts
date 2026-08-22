import { describe, expect, it } from 'vitest';

import {
    SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX,
    SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES,
    SESSION_LATERAL_PICKER_REACH_ROWS,
    SESSION_LATERAL_PICKER_ROW_PITCH_PX,
    SESSION_LATERAL_PICKER_VISIBLE_WINDOW_ROWS,
    resolveSessionLateralPickerCommit,
    resolveSessionLateralPickerFrame,
    resolveSessionLateralPickerRowMotion,
    resolveSessionLateralPickerState,
    type SessionLateralPickerState,
} from './sessionLateralPickerState';
import {
    SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
    SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
    SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S,
} from './sessionLateralSwipeMotion';

/** A drag left, past activation but well short of the commit distance. */
const STEERING_X = -(SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX + 6);

/**
 * `translationY` is NEGATIVE upward in RNGH. Every browse fixture goes through this
 * helper so a sign inversion in the module cannot be matched by an inverted test.
 */
function upwardTranslationY(rowsPastThreshold: number): number {
    return -(SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX + rowsPastThreshold * SESSION_LATERAL_PICKER_ROW_PITCH_PX);
}

function browsing(rowsPastThreshold: number, availableInDirection: number): SessionLateralPickerState {
    return resolveSessionLateralPickerState({
        translationX: STEERING_X,
        translationY: upwardTranslationY(rowsPastThreshold),
        availableInDirection,
        lockedDirection: 'next',
    });
}

describe('resolveSessionLateralPickerState', () => {
    it('stays idle for a horizontal drag below the activation offset', () => {
        const state = resolveSessionLateralPickerState({
            translationX: SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX - 1,
            translationY: 0,
            availableInDirection: 4,
            lockedDirection: null,
        });

        expect(state.phase).toBe('idle');
        expect(state.direction).toBeNull();
        expect(state.index).toBe(0);
    });

    it('locks the direction from the sign of the horizontal travel and selects the immediate neighbour', () => {
        const towardNext = resolveSessionLateralPickerState({
            translationX: -SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
            translationY: 0,
            availableInDirection: 4,
            lockedDirection: null,
        });
        const towardPrevious = resolveSessionLateralPickerState({
            translationX: SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
            translationY: 0,
            availableInDirection: 4,
            lockedDirection: null,
        });

        expect(towardNext.phase).toBe('steering');
        expect(towardNext.direction).toBe('next');
        expect(towardNext.index).toBe(1);
        expect(towardPrevious.direction).toBe('previous');
        expect(towardPrevious.index).toBe(1);
    });

    it('never opens the picker on vertical travel alone, so a tap or a vertical intent is untouched', () => {
        const state = resolveSessionLateralPickerState({
            translationX: 0,
            translationY: upwardTranslationY(4),
            availableInDirection: 8,
            lockedDirection: null,
        });

        expect(state.phase).toBe('idle');
        expect(state.direction).toBeNull();
        expect(state.browseProgress).toBe(0);
    });

    it('steps the selection one row per pitch as the finger rises', () => {
        expect(browsing(0, 10).phase).toBe('browsing');
        expect(browsing(0, 10).index).toBe(1);
        expect(browsing(0.99, 10).index).toBe(1);
        expect(browsing(1, 10).index).toBe(2);
        expect(browsing(2, 10).index).toBe(3);
    });

    it('clamps the selection at the last entry and rubber-bands past it instead of hard-stopping', () => {
        const atEnd = browsing(2, 3);
        const past = browsing(3, 3);
        const farPast = browsing(6, 3);

        // Three entries that way => the immediate neighbour plus two further rows.
        expect(atEnd.index).toBe(3);
        expect(past.index).toBe(3);
        expect(farPast.index).toBe(3);
        expect(atEnd.rowOffset).toBeCloseTo(2, 5);
        // Still answers the finger, never reaches the row that does not exist, and each
        // further pixel buys strictly less travel than the one before it.
        expect(past.rowOffset).toBeGreaterThan(atEnd.rowOffset);
        expect(farPast.rowOffset).toBeGreaterThan(past.rowOffset);
        expect(farPast.rowOffset).toBeLessThan(3);
        expect(farPast.rowOffset - past.rowOffset).toBeLessThan(past.rowOffset - atEnd.rowOffset);
    });

    it('returns to the immediate neighbour when the finger drops back below the browse threshold', () => {
        const state = resolveSessionLateralPickerState({
            translationX: STEERING_X,
            translationY: -(SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX - 1),
            availableInDirection: 8,
            lockedDirection: 'next',
        });

        expect(state.phase).toBe('steering');
        expect(state.index).toBe(1);
        expect(state.browseProgress).toBe(0);
        expect(state.rowOffset).toBe(0);
    });

    it('opens from nothing at the threshold and is fully open by the first full row', () => {
        expect(browsing(0, 8).browseProgress).toBe(0);
        expect(browsing(0.5, 8).browseProgress).toBeCloseTo(0.5, 5);
        expect(browsing(1, 8).browseProgress).toBe(1);
        expect(browsing(4, 8).browseProgress).toBe(1);
    });

    it('holds the locked direction through the neutral zone, so a zero crossing cannot flicker it', () => {
        // Inside the activation band there is no honest sign to read, so the lock bridges it.
        const state = resolveSessionLateralPickerState({
            translationX: SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX - 1,
            translationY: 0,
            availableInDirection: 4,
            lockedDirection: 'next',
        });

        expect(state.direction).toBe('next');
    });

    it('re-locks when the finger deliberately travels the OTHER way past the activation offset', () => {
        // Without this, one gesture can only ever browse one direction: coming back through
        // the middle and swiping the other way kept listing the first direction's sessions,
        // and an accidental few pixels at touch-down decided the whole gesture.
        const state = resolveSessionLateralPickerState({
            translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 2,
            translationY: 0,
            availableInDirection: 4,
            lockedDirection: 'next',
        });

        expect(state.direction).toBe('previous');
    });

    it('does not open a picker that would list a single row', () => {
        const state = browsing(2, 1);

        expect(state.phase).toBe('steering');
        expect(state.index).toBe(1);
        expect(state.browseProgress).toBe(0);
    });

    it('has nothing to select when the locked direction has no entries at all', () => {
        const state = resolveSessionLateralPickerState({
            translationX: STEERING_X,
            translationY: 0,
            availableInDirection: 0,
            lockedDirection: 'next',
        });

        expect(state.phase).toBe('steering');
        expect(state.index).toBe(0);
    });
});

describe('resolveSessionLateralPickerCommit', () => {
    const steering = resolveSessionLateralPickerState({
        translationX: STEERING_X,
        translationY: 0,
        availableInDirection: 8,
        lockedDirection: 'next',
    });

    it('cancels a steering release that never reached the commit distance', () => {
        expect(resolveSessionLateralPickerCommit({
            state: steering,
            translationX: -(SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX - 1),
            velocityX: 0,
        })).toBeNull();
    });

    it('commits the immediate neighbour on a steering release at the commit distance', () => {
        expect(resolveSessionLateralPickerCommit({
            state: steering,
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
            velocityX: 0,
        })).toEqual({ direction: 'next', index: 1 });
    });

    it('still honours the shipped flick rule rather than re-deciding the horizontal commit', () => {
        expect(resolveSessionLateralPickerCommit({
            state: steering,
            translationX: -24,
            velocityX: -SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S,
        })).toEqual({ direction: 'next', index: 1 });
    });

    it('commits the scrubbed selection regardless of horizontal distance once the picker is open', () => {
        expect(resolveSessionLateralPickerCommit({
            state: browsing(2, 8),
            translationX: -4,
            velocityX: 0,
        })).toEqual({ direction: 'next', index: 3 });
    });

    it('cancels when the finger crossed back over the origin, whatever the raw travel says', () => {
        expect(resolveSessionLateralPickerCommit({
            state: steering,
            translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 2,
            velocityX: 0,
        })).toBeNull();
    });

    it('commits nothing from any phase when the system claimed the gesture', () => {
        expect(resolveSessionLateralPickerCommit({
            state: browsing(2, 8),
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 2,
            velocityX: -2000,
            cancelled: true,
        })).toBeNull();
        expect(resolveSessionLateralPickerCommit({
            state: steering,
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 2,
            velocityX: 0,
            cancelled: true,
        })).toBeNull();
    });

    it('commits nothing from idle', () => {
        const idle = resolveSessionLateralPickerState({
            translationX: 0,
            translationY: 0,
            availableInDirection: 8,
            lockedDirection: null,
        });

        expect(resolveSessionLateralPickerCommit({
            state: idle,
            translationX: 0,
            velocityX: 0,
        })).toBeNull();
    });

    it('never commits into a direction the captured order has no entry for', () => {
        const rubberBanding = resolveSessionLateralPickerState({
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 2,
            translationY: 0,
            availableInDirection: 0,
            lockedDirection: 'next',
        });

        expect(resolveSessionLateralPickerCommit({
            state: rubberBanding,
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 2,
            velocityX: -2000,
        })).toBeNull();
    });
});

describe('resolveSessionLateralPickerRowMotion', () => {
    const row = (entryIndex: number, rowOffset: number, overrides?: Partial<{ browseProgress: number; reducedMotion: boolean }>) =>
        resolveSessionLateralPickerRowMotion({
            entryIndex,
            rowOffset,
            browseProgress: overrides?.browseProgress ?? 1,
            reducedMotion: overrides?.reducedMotion ?? false,
        });

    it('paints nothing at all while the picker is shut', () => {
        for (let entryIndex = 1; entryIndex <= SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES; entryIndex += 1) {
            expect(row(entryIndex, 0, { browseProgress: 0 }).opacity).toBe(0);
        }
    });

    it('stacks the rows one pitch apart above the capsule, nearest first', () => {
        // Rows are laid out against the capsule's top edge, so UP is negative.
        expect(row(1, 0).translateY).toBe(0);
        expect(row(2, 0).translateY).toBe(-SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        expect(row(3, 0).translateY).toBe(-2 * SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        // The pitch is CONSTANT the whole way up the column — the stack never recedes, so
        // every row sits exactly its slot count of pitches above the capsule, including
        // the deepest one the reach mounts.
        for (let entryIndex = 2; entryIndex <= SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES; entryIndex += 1) {
            expect(row(entryIndex, 0).translateY).toBe(-(entryIndex - 1) * SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        }
    });

    it('shifts the whole list down by exactly one pitch per selected index, so the capsule is the window', () => {
        // The row the selection has reached sits exactly where the capsule is.
        expect(row(2, 1).translateY).toBe(0);
        expect(row(3, 2).translateY).toBe(0);
        // And it took its neighbours down with it, rigidly.
        expect(row(3, 1).translateY).toBe(-SESSION_LATERAL_PICKER_ROW_PITCH_PX);
        expect(row(4, 2).translateY).toBe(-SESSION_LATERAL_PICKER_ROW_PITCH_PX);
    });

    it('dissolves a row as it descends into the capsule and is gone by the time it arrives', () => {
        expect(row(2, 0).opacity).toBe(1);
        expect(row(2, 0.5).opacity).toBeCloseTo(0.5, 5);
        expect(row(2, 1).opacity).toBe(0);
        // The immediate neighbour is IN the capsule from the start: the readout paints it,
        // so a second copy of it above the bar would be the same session drawn twice.
        expect(row(1, 0).opacity).toBe(0);
    });

    it('recedes over a five-row window, so depth is a gradient and the rest is not painted', () => {
        // The reach is deep, but only the near rows are a DECISION — the rest is the
        // knowledge that the list continues. So the column paints a short window that
        // fades with distance, and everything past it is genuinely at zero rather than
        // drawn faintly: eighteen rows at one opacity is a wall, not a list.
        const window = SESSION_LATERAL_PICKER_VISIBLE_WINDOW_ROWS;
        const opacities: number[] = [];
        for (let slot = 1; slot <= window; slot += 1) {
            opacities.push(row(slot + 1, 0).opacity);
        }

        // The nearest row is the next candidate, and it is fully present.
        expect(opacities[0]).toBe(1);
        // Each row further away is strictly dimmer than the one below it.
        for (let i = 1; i < opacities.length; i += 1) {
            expect(opacities[i]).toBeLessThan(opacities[i - 1] as number);
        }
        // The last one in the window is still faintly there — that faintness is the
        // signal that there is more above, so it must not round to nothing.
        expect(opacities[window - 1] as number).toBeGreaterThan(0);

        // And past the window nothing paints at all, however deep the reach goes.
        expect(row(window + 2, 0).opacity).toBe(0);
        expect(row(SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES, 0).opacity).toBe(0);
    });

    it('reveals the next row as the scrub pulls the column down', () => {
        // The window is anchored to the CAPSULE, not to the list, so scrubbing up moves
        // the list through it: a row that was past the window arrives, and every row
        // already inside brightens as it descends. That reveal is the whole reason the
        // depth is worth having — you can feel your way to a session you cannot yet see.
        const arriving = window_row_at(row, SESSION_LATERAL_PICKER_VISIBLE_WINDOW_ROWS + 2);
        expect(arriving.hidden).toBe(0);
        expect(arriving.pulledOnce).toBeGreaterThan(arriving.hidden);
        expect(arriving.pulledTwice).toBeGreaterThan(arriving.pulledOnce);
    });

    it('emerges from the capsule as it opens, and lands without that travel under reduced motion', () => {
        const opening = row(3, 0, { browseProgress: 0.5 });
        const open = row(3, 0, { browseProgress: 1 });
        expect(opening.translateY).toBeGreaterThan(open.translateY);

        const reduced = row(3, 0, { browseProgress: 0.5, reducedMotion: true });
        expect(reduced.translateY).toBe(open.translateY);
        // Reduced motion drops the decorative lift, never the selection itself: the list
        // still shifts under the capsule, because that shift IS the readout.
        expect(row(3, 2, { reducedMotion: true }).translateY).toBe(0);
        expect(reduced.opacity).toBeGreaterThan(0);
    });
});

describe('resolveSessionLateralPickerFrame', () => {
    it('pairs the direction it locks with THAT direction\'s count, on the very frame it locks', () => {
        // Four sessions back, one ahead. A caller that had to choose a count before the
        // direction existed would open a four-row picker on a drag toward the single
        // session ahead — which is exactly the hazard this entry point removes.
        const towardPrevious = resolveSessionLateralPickerFrame({
            translationX: SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
            translationY: upwardTranslationY(2),
            availablePrevious: 4,
            availableNext: 1,
            lockedDirection: null,
        });
        const towardNext = resolveSessionLateralPickerFrame({
            translationX: -SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
            translationY: upwardTranslationY(2),
            availablePrevious: 4,
            availableNext: 1,
            lockedDirection: null,
        });

        expect(towardPrevious.direction).toBe('previous');
        expect(towardPrevious.phase).toBe('browsing');
        expect(towardPrevious.index).toBe(3);

        expect(towardNext.direction).toBe('next');
        expect(towardNext.phase).toBe('steering');
        expect(towardNext.index).toBe(1);
    });

    it('re-reads the horizontal outside the neutral band, and counts against the direction it just re-locked', () => {
        // A positive horizontal is `previous`, whatever the gesture locked earlier: the user
        // came back through the middle and swiped the other way, and the rows must follow.
        // The count has to follow with it, or the picker would size itself against the
        // direction the user just left.
        const state = resolveSessionLateralPickerFrame({
            translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
            translationY: upwardTranslationY(1),
            availablePrevious: 5,
            availableNext: 1,
            lockedDirection: 'next',
        });

        expect(state.direction).toBe('previous');
        expect(state.index).toBe(2);
    });

    it('holds the lock inside the neutral band, where there is no sign to read', () => {
        const state = resolveSessionLateralPickerFrame({
            translationX: SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX - 1,
            translationY: upwardTranslationY(1),
            availablePrevious: 1,
            availableNext: 5,
            lockedDirection: 'next',
        });

        expect(state.direction).toBe('next');
        expect(state.index).toBe(2);
    });

    it('is idle below activation, and asks for no count to say so', () => {
        const state = resolveSessionLateralPickerFrame({
            translationX: SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX - 1,
            translationY: upwardTranslationY(3),
            availablePrevious: 6,
            availableNext: 6,
            lockedDirection: null,
        });

        expect(state.phase).toBe('idle');
        expect(state.direction).toBeNull();
    });
});

describe('the picker reach', () => {
    it('mounts one row past the visible column, so scrubbing pulls the next one in rather than ending', () => {
        expect(SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES)
            .toBe(SESSION_LATERAL_PICKER_REACH_ROWS + 1);
    });

    it('reaches eighteen rows, which is what the constant pitch costs in finger travel', () => {
        // The reach IS travel: the Nth row costs the browse threshold plus N pitches, so
        // eighteen rows is 28 + 18 * 36 = 676px of upward arc, and nothing compresses that.
        // Pinned in absolute pixels on purpose. Everything else here derives from the
        // constants and so follows them silently; this is the one assertion that makes a
        // pitch or row-count change state its cost in thumb travel out loud.
        const reachTravelPx = SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX
            + SESSION_LATERAL_PICKER_REACH_ROWS * SESSION_LATERAL_PICKER_ROW_PITCH_PX;
        const deepest = resolveSessionLateralPickerState({
            translationX: STEERING_X,
            translationY: -reachTravelPx,
            availableInDirection: SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES * 4,
            lockedDirection: 'next',
        });
        const oneShort = resolveSessionLateralPickerState({
            translationX: STEERING_X,
            translationY: -(reachTravelPx - SESSION_LATERAL_PICKER_ROW_PITCH_PX),
            availableInDirection: SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES * 4,
            lockedDirection: 'next',
        });

        expect(reachTravelPx).toBe(676);
        expect(deepest.index).toBe(SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES);
        expect(oneShort.index).toBe(SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES - 1);
    });
});

describe('the row that descends into the capsule is the row the release commits', () => {
    // A hundredth of a pixel: far below anything a finger can express.
    const NUDGE_PX = 0.01;
    const at = (browseTravelPx: number, availableInDirection: number) => resolveSessionLateralPickerState({
        translationX: STEERING_X,
        translationY: -(SESSION_LATERAL_PICKER_BROWSE_THRESHOLD_PX + browseTravelPx),
        availableInDirection,
        lockedDirection: 'next',
    });

    it('holds at every reachable depth', () => {
        const available = SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES;
        for (let entryIndex = 2; entryIndex <= available; entryIndex += 1) {
            const arrivalPx = (entryIndex - 1) * SESSION_LATERAL_PICKER_ROW_PITCH_PX;

            const arrived = at(arrivalPx + NUDGE_PX, available);
            expect(arrived.index).toBe(entryIndex);
            const inCapsule = resolveSessionLateralPickerRowMotion({
                entryIndex,
                rowOffset: arrived.rowOffset,
                browseProgress: arrived.browseProgress,
                reducedMotion: false,
            });
            // The selected row is AT the capsule and has finished handing over to it.
            expect(inCapsule.translateY).toBeCloseTo(0, 1);
            expect(inCapsule.opacity).toBe(0);

            const notYet = at(arrivalPx - NUDGE_PX, available);
            expect(notYet.index).toBe(entryIndex - 1);
            const stillAbove = resolveSessionLateralPickerRowMotion({
                entryIndex,
                rowOffset: notYet.rowOffset,
                browseProgress: notYet.browseProgress,
                reducedMotion: false,
            });
            expect(stillAbove.translateY).toBeLessThan(0);
        }
    });
});

/**
 * One row's opacity as the scrub pulls it down through the window, so a reveal can be
 * asserted as the monotone brightening it is rather than as three loose numbers.
 */
function window_row_at(
    row: (entryIndex: number, rowOffset: number) => { opacity: number },
    entryIndex: number,
): Readonly<{ hidden: number; pulledOnce: number; pulledTwice: number }> {
    return {
        hidden: row(entryIndex, 0).opacity,
        pulledOnce: row(entryIndex, 1).opacity,
        pulledTwice: row(entryIndex, 2).opacity,
    };
}
