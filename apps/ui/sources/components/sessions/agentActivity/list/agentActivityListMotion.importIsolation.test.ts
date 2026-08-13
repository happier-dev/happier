import { describe, expect, it, vi } from 'vitest';

/**
 * The roster's layout animations must be IMPORTABLE without a Reanimated runtime.
 *
 * This module is reached from `AgentActivityList`, which sits inside the session shell, so a suite
 * that renders any part of that shell imports it whether or not a row ever moves. Building the
 * builders at module scope therefore made `LinearTransition.springify()` run during collection —
 * and the ~60 suites that narrow the `react-native-reanimated` mock failed there, with an error
 * about an animation they never rendered. Same contract as
 * `components/ui/motion/motionSprings.importIsolation.test.ts`.
 *
 * The partial mock below is the condition under test, not a shortcut around the testkit.
 */
vi.mock('react-native-reanimated', () => ({}));

describe('agent roster list motion import isolation', () => {
    it('answers the reduced-motion case without reading one, because both animations settle instantly', async () => {
        const { resolveAgentActivityListMotion } = await import('./agentActivityListMotion');

        const motion = resolveAgentActivityListMotion({ reducedMotion: true, arrived: true });

        expect(motion.layout).toBeUndefined();
        expect(motion.entering).toBeUndefined();
    });

    /**
     * The list must not be a second reader of the reduced-motion policy. Expectations here are
     * DERIVED from the table rather than written down, so flipping a row in
     * `reducedMotionTable.ts` fails this test instead of silently leaving the roster animating
     * against the rest of the app.
     */
    it('derives its reduced-motion answer from the animation table, not from its own copy', async () => {
        const { resolveAgentActivityListMotion } = await import('./agentActivityListMotion');
        const { resolveMotionPresentation } = await import('@/components/ui/motion');

        const motion = resolveAgentActivityListMotion({ reducedMotion: true, arrived: true });

        expect(motion.layout === undefined)
            .toBe(resolveMotionPresentation('sectionMigration', true) === 'settleInstantly');
        expect(motion.entering === undefined)
            .toBe(resolveMotionPresentation('rowEnter', true) === 'settleInstantly');
    });
});
