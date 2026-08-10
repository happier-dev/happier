import { describe, expect, it } from 'vitest';

import { resolveMotionReducedFallback } from './motionSprings';
import {
    MOTION_ANIMATIONS,
    MOTION_ELAPSED_TICK_MS,
    resolveElapsedTickCadence,
    resolveMotionAnimationSpringRole,
    resolveMotionPresentation,
    type MotionAnimationId,
    type MotionPresentation,
} from './reducedMotionTable';

/**
 * The table's value is not that it exists — it is that it cannot disagree with the spring table,
 * cannot silently gain an unmapped animation, and cannot answer "nothing happens" for anything.
 * Each test below fails for exactly one of those.
 */

describe('reduced-motion mapping table', () => {
    it('answers for every animation this program ships, in both preferences', () => {
        for (const animation of MOTION_ANIMATIONS) {
            expect(resolveMotionPresentation(animation, false)).toBe('animate');
            expect(typeof resolveMotionPresentation(animation, true)).toBe('string');
        }
        expect(MOTION_ANIMATIONS).toHaveLength(8);
    });

    it('derives every spring-backed row from the spring table instead of restating it', () => {
        const springBacked = MOTION_ANIMATIONS
            .map((animation) => ({ animation, role: resolveMotionAnimationSpringRole(animation) }))
            .filter((entry): entry is { animation: MotionAnimationId; role: NonNullable<ReturnType<typeof resolveMotionAnimationSpringRole>> } => entry.role !== null);

        // If this list ever empties, the table has stopped being derived and every row is a
        // hand-maintained copy again.
        expect(springBacked.length).toBeGreaterThan(0);

        for (const { animation, role } of springBacked) {
            const expected: MotionPresentation = resolveMotionReducedFallback(role) === 'unchanged'
                ? 'animate'
                : 'settleInstantly';
            expect(resolveMotionPresentation(animation, true)).toBe(expected);
        }
    });

    it('maps each animation to the fallback that preserves what it was carrying', () => {
        const reduced = Object.fromEntries(
            MOTION_ANIMATIONS.map((animation) => [animation, resolveMotionPresentation(animation, true)]),
        );

        expect(reduced).toEqual({
            // Feedback under a finger that is already there. Not vestibular travel, so it stays.
            press: 'animate',
            // Still appears and still leaves; only the 90 ms exit fade goes.
            focusRing: 'settleInstantly',
            // The mark still changes — instantly.
            statusSettle: 'settleInstantly',
            rowEnter: 'settleInstantly',
            rowExit: 'settleInstantly',
            sectionMigration: 'settleInstantly',
            // A static mark replaces the rotation; the row never loses its status.
            spinner: 'substitute',
            // Slowed, never stopped: this is the only remaining evidence of liveness once the
            // spinner has been substituted out.
            elapsedTick: 'slowCadence',
        });
    });

    it('keeps the elapsed clock running under reduced motion, slower rather than stopped', () => {
        expect(resolveElapsedTickCadence()).toEqual({
            intervalMs: MOTION_ELAPSED_TICK_MS.animate,
            reducedMotionIntervalMs: MOTION_ELAPSED_TICK_MS.slowCadence,
        });

        // The point of the essential-motion exception: a finite, positive, *slower* cadence. A zero
        // or an Infinity here would be a frozen clock on a running agent, which is a lie.
        expect(Number.isFinite(MOTION_ELAPSED_TICK_MS.slowCadence)).toBe(true);
        expect(MOTION_ELAPSED_TICK_MS.slowCadence).toBeGreaterThan(MOTION_ELAPSED_TICK_MS.animate);
        expect(MOTION_ELAPSED_TICK_MS.animate).toBeGreaterThan(0);
    });
});
