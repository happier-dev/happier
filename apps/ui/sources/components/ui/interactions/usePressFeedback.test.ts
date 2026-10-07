import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';

import { usePressFeedback } from './usePressFeedback';

const motion = vi.hoisted(() => ({ reduced: false }));
const timingCalls = vi.hoisted(() => [] as Array<Readonly<{ value: unknown; duration: unknown }>>);

// The host accessibility preference is the boundary; its watch is process-global,
// so the test drives the reactive read directly (as the voice control suite does).
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => motion.reduced,
}));

// The canonical Reanimated stub lands every animation on its target at once, which
// hides whether an acknowledgement was immediate or eased. Recording `withTiming`
// on top of that factory is the only extension this suite needs.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const base = createReanimatedModuleMock();
    return {
        ...base,
        withTiming: <T,>(value: T, config?: Readonly<{ duration?: number }>): T => {
            timingCalls.push({ value, duration: config?.duration });
            return value;
        },
    };
});

describe('usePressFeedback', () => {
    beforeEach(() => {
        motion.reduced = false;
        timingCalls.length = 0;
    });

    it('scales down on press-in and settles back on release, acknowledging faster than it settles', async () => {
        const hook = await renderHook(() => usePressFeedback());

        hook.getCurrent().onPressIn();
        expect((await hook.rerender()).animatedStyle).toEqual({ transform: [{ scale: motionTokens.press.scale }] });
        expect(timingCalls).toEqual([{ value: 1, duration: motionTokens.durationMs.press }]);

        hook.getCurrent().onPressOut();
        expect((await hook.rerender()).animatedStyle).toEqual({ transform: [{ scale: 1 }] });
        expect(timingCalls[1]).toEqual({ value: 0, duration: motionTokens.durationMs.release });
        expect(motionTokens.durationMs.press).toBeLessThan(motionTokens.durationMs.release);

        await hook.unmount();
    });

    it('acknowledges immediately as an opacity change, never spatial motion, when reduced motion is preferred', async () => {
        motion.reduced = true;
        const hook = await renderHook(() => usePressFeedback());

        hook.getCurrent().onPressIn();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: 0.7 });

        hook.getCurrent().onPressOut();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: 1 });
        expect(timingCalls).toEqual([]);

        await hook.unmount();
    });

    it('pairs the scale with an opacity dip for a small glyph, where scale alone moves under a pixel', async () => {
        const hook = await renderHook(() => usePressFeedback({ glyph: true }));

        hook.getCurrent().onPressIn();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: 0.7, transform: [{ scale: motionTokens.press.scale }] });
        expect(timingCalls).toEqual([{ value: 1, duration: motionTokens.durationMs.press }]);

        hook.getCurrent().onPressOut();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: 1, transform: [{ scale: 1 }] });

        await hook.unmount();
    });

    it('drops the glyph scale but keeps its opacity acknowledgement when reduced motion is preferred', async () => {
        motion.reduced = true;
        const hook = await renderHook(() => usePressFeedback({ glyph: true }));

        hook.getCurrent().onPressIn();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: 0.7 });

        await hook.unmount();
    });

    it('lets a caller-owned motion cap force the opacity-only acknowledgement', async () => {
        const hook = await renderHook(() => usePressFeedback({ reduced: true }));

        hook.getCurrent().onPressIn();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: motionTokens.press.opacity });
        expect(timingCalls).toEqual([]);

        await hook.unmount();
    });

    it('exposes its progress and the deltas it applies, so a composed transform stays on the same values', async () => {
        const hook = await renderHook(() => usePressFeedback());
        expect(hook.getCurrent().scaleDelta).toBeCloseTo(1 - motionTokens.press.scale);
        expect(hook.getCurrent().opacityDelta).toBe(0);

        hook.getCurrent().onPressIn();
        expect(hook.getCurrent().progress.get()).toBe(1);
        await hook.unmount();

        const reduced = await renderHook(() => usePressFeedback({ reduced: true }));
        expect(reduced.getCurrent().scaleDelta).toBe(0);
        expect(reduced.getCurrent().opacityDelta).toBeCloseTo(1 - motionTokens.press.opacity);
        await reduced.unmount();
    });

    it('keeps an eased opacity response without movement for a static control', async () => {
        const hook = await renderHook(() => usePressFeedback({ static: true }));

        hook.getCurrent().onPressIn();
        expect((await hook.rerender()).animatedStyle).toEqual({ opacity: 0.7 });
        expect(timingCalls).toEqual([{ value: 1, duration: motionTokens.durationMs.press }]);

        await hook.unmount();
    });
});
