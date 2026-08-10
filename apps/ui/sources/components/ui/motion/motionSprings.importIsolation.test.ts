import { describe, expect, it, vi } from 'vitest';

/**
 * The spring vocabulary must be IMPORTABLE without a Reanimated runtime.
 *
 * A component tree does not have to animate to pull this module in: the `components/ui/motion`
 * barrel re-exports it, and `slideTransitionTokens` builds on it. So when the resolver assembled
 * its config tables at module scope — reading `ReduceMotion` during evaluation — importing
 * anything from that barrel under a narrow `react-native-reanimated` mock failed the whole FILE at
 * collection. Measured: 285 failures across 23 suites, none of them about motion.
 *
 * `dev/vitestSetup.ts` installs the canonical `createReanimatedModuleMock()` for every suite, but
 * 60+ suites still override it with a hand-rolled subset. Depending on all of them to restate a
 * new export is not a contract; not needing the runtime until a spring is actually asked for is.
 *
 * This file hand-rolls a mock WITHOUT `ReduceMotion` on purpose — that partial mock is the
 * condition under test, not a shortcut around the testkit.
 */
vi.mock('react-native-reanimated', () => ({}));

describe('motion import isolation', () => {
    it('imports the spring vocabulary and serves its physics without reading a Reanimated runtime value', async () => {
        const { MOTION_SPRING_ROLES, describeMotionSpring } = await import('./motionSprings');

        expect(MOTION_SPRING_ROLES).toContain('press');
        expect(describeMotionSpring('press').dampingRatio).toBeCloseTo(1, 6);
    });

    it('imports the whole motion barrel, which is what non-animating consumers actually reach', async () => {
        // The barrel is the surface every consumer imports, and adding `StatusTransition` to it
        // pulled `reanimatedMotionTokens` — and its module-scope `Easing.bezier(...)` — into every
        // one of them. The contract is the barrel's, not any single module's.
        const motion = await import('./index');

        expect(motion.resolveMotionSpring).toBeTypeOf('function');
        expect(motion.motionTokens.durationMs).toBeDefined();
    });
});
