import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

/**
 * The spring config is otherwise unobservable — the testkit mock resolves `withSpring` to its
 * target value. Wrapping the canonical mock (rather than replacing it) records the configs the
 * hook actually hands to reanimated, which is the only way to catch a hook that quietly keeps one
 * companion's settle for both.
 */
const springCalls = vi.hoisted(() => [] as Array<Readonly<Record<string, unknown>>>);
const timingCalls = vi.hoisted(() => [] as Array<Readonly<Record<string, unknown>>>);

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const base = createReanimatedModuleMock() as Record<string, unknown>;
    return {
        ...base,
        default: (base as { default?: unknown }).default,
        withSpring: <T,>(value: T, config?: Readonly<Record<string, unknown>>): T => {
            springCalls.push(config ?? {});
            return value;
        },
        withTiming: <T,>(value: T, config?: Readonly<Record<string, unknown>>): T => {
            timingCalls.push(config ?? {});
            return value;
        },
    };
});

import {
    COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT,
    useCompanionNativePanGesture,
    type CompanionPoint,
} from './useCompanionNativePanGesture';
import { resolveCompanionReleaseSpringConfig } from './companionReleaseMotion';
import { PET_COMPANION_RELEASE_MOTION } from '@/components/pets/interaction/petPointerDragBindings';
import { resolvePetNativeDragAnimationState } from '@/components/pets/interaction/resolvePetDragAnimationState';
import { VOICE_ORB_RELEASE_MOTION } from '@/components/voice/orb/voiceOrbGeometry';

type TestGesture = Readonly<{
    __config: Readonly<{ minDistance?: number; testId?: string }>;
    __handlers: Record<string, (...args: unknown[]) => void>;
}>;

const bounds = { minX: 12, maxX: 282, minY: 71, maxY: 394 } as const;

beforeEach(() => {
    springCalls.length = 0;
    timingCalls.length = 0;
});

function flick(gesture: TestGesture, event: Readonly<{
    translationX: number;
    translationY: number;
    velocityX: number;
    velocityY: number;
}>): void {
    gesture.__handlers.onBegin?.({ absoluteX: 120, absoluteY: 200, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0 });
    gesture.__handlers.onUpdate?.({ ...event, absoluteX: 120 + event.translationX, absoluteY: 200 + event.translationY });
    gesture.__handlers.onEnd?.({ ...event, absoluteX: 120 + event.translationX, absoluteY: 200 + event.translationY }, true);
}

describe('useCompanionNativePanGesture', () => {
    it('uses a 4 pt Pan gesture threshold and ignores starts inside no-drag regions', async () => {
        const onPositionChange = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [{ id: 'tray-action', x: 100, y: 180, width: 80, height: 60 }],
            releaseMotion: PET_COMPANION_RELEASE_MOTION,
            onPositionChange,
        }));

        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        expect(gesture.__config.minDistance).toBe(COMPANION_NATIVE_PAN_DRAG_THRESHOLD_PT);

        await act(async () => {
            flick(gesture, { translationX: 60, translationY: 40, velocityX: 700, velocityY: 200 });
        });

        expect(onPositionChange).not.toHaveBeenCalled();
    });

    it('keeps the pet unchanged: clamped drag, running direction, persisted point, release velocity', async () => {
        const onPositionChange = vi.fn();
        const onDragRelease = vi.fn();
        const onDragStateChange = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            releaseMotion: PET_COMPANION_RELEASE_MOTION,
            // Exactly the value `PetAppShellCompanionMount.native.tsx` hands to this slot, so the
            // hook test and the live mount cannot drift.
            resolveDragState: resolvePetNativeDragAnimationState,
            onDragStateChange,
            onPositionChange,
            onDragRelease,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;

        await act(async () => {
            flick(gesture, { translationX: 300, translationY: -300, velocityX: 1_900, velocityY: -200 });
        });

        expect(hook.getCurrent().point).toEqual({ x: 282, y: 71 });
        expect(onDragStateChange).toHaveBeenCalledWith('running-right');
        expect(onPositionChange).toHaveBeenCalledWith({ point: { x: 282, y: 71 } });
        expect(onDragRelease).toHaveBeenCalledWith({
            velocityX: 1_900,
            velocityY: -200,
            target: { x: 282, y: 71 },
        });
        // The pet's settle, unchanged, and no velocity handoff.
        expect(springCalls).toEqual([
            { duration: 280, dampingRatio: 0.78, overshootClamping: true },
            { duration: 280, dampingRatio: 0.78, overshootClamping: true },
        ]);
        expect(timingCalls).toHaveLength(1);
    });

    /**
     * The decision this hook exists to enforce: the pet must not gain the orb's momentum
     * projection, and the orb must not inherit the pet's settle. A hook with either baked in
     * passes one of these two and fails the other.
     */
    it('does not project a pet throw — it settles where the finger let go', async () => {
        const onDragRelease = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            releaseMotion: PET_COMPANION_RELEASE_MOTION,
            onDragRelease,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;

        await act(async () => {
            flick(gesture, { translationX: 20, translationY: 0, velocityX: 1_200, velocityY: 0 });
        });

        // 1_200 px/s × the orb's 0.499 s would have thrown this to the right bound.
        expect(onDragRelease.mock.calls[0]?.[0].target).toEqual({ x: 140, y: 200 });
    });

    it('projects an orb throw with the orb coefficient and hands the target to its resolver', async () => {
        const seen: Array<Readonly<{ released: CompanionPoint; projected: CompanionPoint }>> = [];
        const onDragRelease = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            releaseMotion: VOICE_ORB_RELEASE_MOTION,
            resolveReleaseTarget: (input) => {
                seen.push({ released: input.released, projected: input.projected });
                // Edge snap, exactly as the orb does it.
                return { x: input.projected.x > 150 ? bounds.maxX : bounds.minX, y: input.released.y };
            },
            onDragRelease,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;

        await act(async () => {
            flick(gesture, { translationX: 20, translationY: 0, velocityX: 1_200, velocityY: 0 });
        });

        expect(seen[0]?.released).toEqual({ x: 140, y: 200 });
        expect(seen[0]?.projected.x).toBeCloseTo(140 + 1_200 * 0.499, 5);
        expect(onDragRelease.mock.calls[0]?.[0].target).toEqual({ x: 282, y: 200 });
        // Critically damped, never clamped, and the throw speed is carried per axis.
        expect(springCalls).toEqual([
            { duration: 400, dampingRatio: 1, velocity: 1_200 },
            { duration: 400, dampingRatio: 1, velocity: 0 },
        ]);
    });

    it('snaps Orb lift and release under reduced motion while preserving 1:1 finger movement', async () => {
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            releaseMotion: VOICE_ORB_RELEASE_MOTION,
            motionPolicy: 'snap',
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;

        await act(async () => {
            gesture.__handlers.onBegin?.({ absoluteX: 120, absoluteY: 200 });
            gesture.__handlers.onUpdate?.({ translationX: 35, translationY: -20 });
        });
        expect(hook.getCurrent().translateX.value).toBe(155);
        expect(hook.getCurrent().translateY.value).toBe(180);
        expect(hook.getCurrent().dragProgress.value).toBe(1);

        await act(async () => {
            gesture.__handlers.onEnd?.({
                translationX: 35,
                translationY: -20,
                velocityX: 900,
                velocityY: -300,
            });
            gesture.__handlers.onFinalize?.();
        });

        expect(springCalls).toHaveLength(0);
        expect(timingCalls).toHaveLength(0);
        expect(hook.getCurrent().dragProgress.value).toBe(0);
    });
});

describe('resolveCompanionReleaseSpringConfig', () => {
    it('gives the pet its clipped overshoot and the orb a critically damped settle', () => {
        expect(resolveCompanionReleaseSpringConfig(PET_COMPANION_RELEASE_MOTION, 900)).toEqual({
            duration: PET_COMPANION_RELEASE_MOTION.durationMs,
            dampingRatio: PET_COMPANION_RELEASE_MOTION.dampingRatio,
            overshootClamping: true,
        });
        expect(resolveCompanionReleaseSpringConfig(VOICE_ORB_RELEASE_MOTION, 900)).toEqual({
            duration: 400,
            dampingRatio: 1,
            velocity: 900,
        });
    });
});
