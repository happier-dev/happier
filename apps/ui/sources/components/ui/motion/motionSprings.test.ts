import { ReduceMotion } from 'react-native-reanimated';
import { describe, expect, it } from 'vitest';

import {
    MOTION_SPRING_ROLES,
    describeMotionSpring,
    resolveMotionReducedFallback,
    resolveMotionSpring,
    type MotionSpringRole,
} from './motionSprings';

/**
 * Re-derived independently of the implementation, from the classical second-order model
 *
 *   omega0 = sqrt(k / m)              zeta = c / (2 * sqrt(k * m))
 *
 * with the settle criterion the plan states (§4.8): the envelope reaching 1% of the initial
 * displacement. For a critically damped spring that is `(1 + omega0*t) * e^(-omega0*t) = 0.01`,
 * whose root is `omega0*t = 6.6384`; for an underdamped one the envelope is `e^(-zeta*omega0*t)`,
 * so `t = ln(100) / (zeta * omega0)`. Overshoot is `exp(-pi*zeta / sqrt(1 - zeta^2))`.
 *
 * These numbers are the contract, not a snapshot: five of seven roles MUST be exactly critically
 * damped, which is what makes "no bounce on ordinary state changes" structural.
 */
const EXPECTED = {
    press: { stiffness: 2500, damping: 100, mass: 1, dampingRatio: 1, settleMs: 132.77, overshootRatio: 0 },
    statusSettle: { stiffness: 900, damping: 60, mass: 1, dampingRatio: 1, settleMs: 221.28, overshootRatio: 0 },
    rowEnter: { stiffness: 625, damping: 50, mass: 1, dampingRatio: 1, settleMs: 265.53, overshootRatio: 0 },
    disclosure: { stiffness: 400, damping: 40, mass: 1, dampingRatio: 1, settleMs: 331.92, overshootRatio: 0 },
    reflow: { stiffness: 256, damping: 32, mass: 1, dampingRatio: 1, settleMs: 414.9, overshootRatio: 0 },
    surface: { stiffness: 400, damping: 32, mass: 1, dampingRatio: 0.8, settleMs: 287.82, overshootRatio: 0.01516 },
    nudge: { stiffness: 784, damping: 31, mass: 1, dampingRatio: 0.553571, settleMs: 297.11, overshootRatio: 0.1239 },
} as const satisfies Record<MotionSpringRole, Readonly<Record<string, number>>>;

const CRITICALLY_DAMPED_ROLES: readonly MotionSpringRole[] = [
    'press',
    'statusSettle',
    'rowEnter',
    'disclosure',
    'reflow',
];

describe('motion spring vocabulary', () => {
    it('publishes exactly the seven role names, in escalating settle order', () => {
        expect([...MOTION_SPRING_ROLES]).toEqual([
            'press',
            'statusSettle',
            'rowEnter',
            'disclosure',
            'reflow',
            'surface',
            'nudge',
        ]);
    });

    it.each(MOTION_SPRING_ROLES)('%s carries the specified physics', (role) => {
        const expected = EXPECTED[role];
        const config = resolveMotionSpring(role, { reducedMotion: false });

        expect(config.stiffness).toBe(expected.stiffness);
        expect(config.damping).toBe(expected.damping);
        expect(config.mass).toBe(expected.mass);
    });

    it.each(MOTION_SPRING_ROLES)('%s derives the specified damping ratio and settle time', (role) => {
        const expected = EXPECTED[role];
        const profile = describeMotionSpring(role);

        expect(profile.angularFrequency).toBeCloseTo(Math.sqrt(expected.stiffness / expected.mass), 6);
        expect(profile.dampingRatio).toBeCloseTo(expected.dampingRatio, 6);
        expect(profile.settleMs).toBeCloseTo(expected.settleMs, 1);
        expect(profile.overshootRatio).toBeCloseTo(expected.overshootRatio, 4);
    });

    it('keeps five of the seven exactly critically damped, and the two exceptions named', () => {
        const critical = MOTION_SPRING_ROLES.filter((role) => describeMotionSpring(role).dampingRatio === 1);
        const bouncy = MOTION_SPRING_ROLES.filter((role) => describeMotionSpring(role).dampingRatio < 1);

        expect([...critical]).toEqual(CRITICALLY_DAMPED_ROLES);
        expect([...bouncy]).toEqual(['surface', 'nudge']);
        for (const role of critical) {
            expect(describeMotionSpring(role).overshootRatio).toBe(0);
        }
    });

    it('never expresses a config in the duration/dampingRatio form', () => {
        // Reanimated 4 accepts either (stiffness, damping) or (duration, dampingRatio) and silently
        // recomputes stiffness for the second form. Mixing them would make the derived physics above
        // a fiction.
        for (const role of MOTION_SPRING_ROLES) {
            const config = resolveMotionSpring(role, { reducedMotion: false }) as Record<string, unknown>;
            expect(config.duration).toBeUndefined();
            expect(config.dampingRatio).toBeUndefined();
        }
    });

    it('describes a spring without handing out something usable AS a spring', () => {
        // `describeMotionSpring` reports physics for tests, docs and derived timings. It must not
        // also be a back door around the resolver, and the danger is not theoretical: a profile
        // carrying `stiffness`/`damping` is structurally assignable to `WithSpringConfig`, so
        // `withSpring(1, describeMotionSpring('press'))` would type-check, skip the `reduceMotion`
        // stamp, AND hand Reanimated a `dampingRatio` alongside a stiffness — the exact
        // duration/dampingRatio mixture the test above declares forbidden.
        for (const role of MOTION_SPRING_ROLES) {
            const profile = describeMotionSpring(role) as Record<string, unknown>;
            expect(profile.stiffness).toBeUndefined();
            expect(profile.damping).toBeUndefined();
            expect(profile.mass).toBeUndefined();
        }
    });
});

describe('reduced-motion policy', () => {
    it('stamps ReduceMotion.Never on every ordinary config so the library cannot second-guess the table', () => {
        for (const role of MOTION_SPRING_ROLES) {
            expect(resolveMotionSpring(role, { reducedMotion: false }).reduceMotion).toBe(ReduceMotion.Never);
        }
    });

    it('maps every role to a fallback, and keeps press feedback alive', () => {
        expect(resolveMotionReducedFallback('press')).toBe('unchanged');
        for (const role of MOTION_SPRING_ROLES.filter((candidate) => candidate !== 'press')) {
            expect(resolveMotionReducedFallback(role)).toBe('instant');
        }
    });

    it('suppresses the vestibular roles under reduced motion without touching their physics', () => {
        for (const role of MOTION_SPRING_ROLES.filter((candidate) => candidate !== 'press')) {
            const reduced = resolveMotionSpring(role, { reducedMotion: true });
            expect(reduced.reduceMotion).toBe(ReduceMotion.Always);
            expect(reduced.stiffness).toBe(EXPECTED[role].stiffness);
            expect(reduced.damping).toBe(EXPECTED[role].damping);
        }
    });

    it('keeps the press spring animating under reduced motion', () => {
        // A 133ms tint on direct manipulation is touch acknowledgement, not vestibular motion:
        // removing it removes the only feedback a press has.
        expect(resolveMotionSpring('press', { reducedMotion: true }).reduceMotion).toBe(ReduceMotion.Never);
    });
});

describe('config identity', () => {
    it('returns one stable object per (role, reducedMotion) pair', () => {
        // Call sites put the config in `useEffect` / `useCallback` dependency arrays
        // (SlideTransitionSwitch and StoryDeckSlideTransition already do). A fresh object per call
        // would re-run every one of those effects on every render.
        for (const role of MOTION_SPRING_ROLES) {
            expect(resolveMotionSpring(role, { reducedMotion: false })).toBe(
                resolveMotionSpring(role, { reducedMotion: false }),
            );
            expect(resolveMotionSpring(role, { reducedMotion: true })).toBe(
                resolveMotionSpring(role, { reducedMotion: true }),
            );
        }
    });

    it('does not hand out a mutable shared config', () => {
        const config = resolveMotionSpring('reflow', { reducedMotion: false });
        expect(Object.isFrozen(config)).toBe(true);
    });
});
