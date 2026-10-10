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
const measurements = vi.hoisted(() => new Map<unknown, { pageX: number; pageY: number; width: number; height: number }>());

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const base = createReanimatedModuleMock() as Record<string, unknown>;
    return {
        ...base,
        default: (base as { default?: unknown }).default,
        measure: (ref: unknown) => measurements.get(ref) ?? null,
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
import { resolveCompanionReleaseSpringConfig } from '@happier-dev/plugin-ui/presentation';
import { PET_COMPANION_RELEASE_MOTION } from '@/components/pets/interaction/petPointerDragBindings';
import { resolvePetNativeDragAnimationState } from '@/components/pets/interaction/resolvePetDragAnimationState';
import { VOICE_ORB_RELEASE_MOTION } from '@/components/voice/presence/voicePresenceGeometry';

type TestGesture = Readonly<{
    __config: Readonly<{ minDistance?: number; testId?: string }>;
    __handlers: Record<string, (...args: unknown[]) => void>;
}>;

const bounds = { minX: 12, maxX: 282, minY: 71, maxY: 394 } as const;

beforeEach(() => {
    springCalls.length = 0;
    timingCalls.length = 0;
    measurements.clear();
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
    it('resumes the destination spring after a touch that never becomes a drag', async () => {
        const onDragRelease = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds, initialPoint: { x: 120, y: 200 }, noDragRegions: [],
            releaseMotion: VOICE_ORB_RELEASE_MOTION, onDragRelease,
            resolveReleaseTarget: () => ({ x: 282, y: 394 }),
        }));
        await act(async () => {
            const gesture = hook.getCurrent().gesture as unknown as TestGesture;
            flick(gesture, { translationX: 30, translationY: 20, velocityX: 500, velocityY: 300 });
            hook.getCurrent().translateX.value = 170;
            hook.getCurrent().translateY.value = 240;
        });
        onDragRelease.mockClear();
        await act(async () => {
            const gesture = hook.getCurrent().gesture as unknown as TestGesture;
            gesture.__handlers.onBegin({ absoluteX: 170, absoluteY: 240 });
            gesture.__handlers.onFinalize({}, false);
        });
        expect([hook.getCurrent().translateX.value, hook.getCurrent().translateY.value]).toEqual([282, 394]);
        expect(onDragRelease).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('discards the old active gesture when control takes over during a drag', async () => {
        const onDragRelease = vi.fn();
        const hook = await renderHook((enabled: boolean) => useCompanionNativePanGesture({
            enabled, bounds, initialPoint: { x: 120, y: 200 }, noDragRegions: [],
            releaseMotion: VOICE_ORB_RELEASE_MOTION, onDragRelease,
        }), { initialProps: true });
        const oldGesture = hook.getCurrent().gesture as unknown as TestGesture;
        await act(async () => {
            oldGesture.__handlers.onBegin({ absoluteX: 120, absoluteY: 200 });
            oldGesture.__handlers.onUpdate({ translationX: 30, translationY: -20 });
        });
        await hook.rerender(false);
        await act(async () => {
            oldGesture.__handlers.onEnd({ translationX: 30, translationY: -20 }, false);
            oldGesture.__handlers.onFinalize({}, false);
        });
        expect([hook.getCurrent().translateX.value, hook.getCurrent().translateY.value]).toEqual([120, 200]);
        expect(onDragRelease).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not cancel a settling spring when its controlled owner echoes the release target', async () => {
        const hook = await renderHook((initialPoint: CompanionPoint) => useCompanionNativePanGesture({
            bounds, initialPoint, noDragRegions: [], releaseMotion: VOICE_ORB_RELEASE_MOTION,
            positionPublication: 'release', resolveReleaseTarget: () => ({ x: 282, y: 394 }),
        }), { initialProps: { x: 120, y: 200 } });
        await act(async () => {
            flick(hook.getCurrent().gesture as unknown as TestGesture,
                { translationX: 30, translationY: 20, velocityX: 500, velocityY: 300 });
            // The OS spring is still between finger release and target when React receives the echo.
            hook.getCurrent().translateX.value = 170;
            hook.getCurrent().translateY.value = 240;
        });
        await hook.rerender({ x: 282, y: 394 });
        expect([hook.getCurrent().translateX.value, hook.getCurrent().translateY.value]).toEqual([170, 240]);
        await hook.rerender({ x: 12, y: 71 });
        expect([hook.getCurrent().translateX.value, hook.getCurrent().translateY.value]).toEqual([12, 71]);
        await hook.unmount();
    });

    it('leaves a controlled picture untouched when native frame movement is disabled', async () => {
        const onDragRelease = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            enabled: false,
            bounds, initialPoint: { x: 120, y: 200 }, noDragRegions: [],
            releaseMotion: VOICE_ORB_RELEASE_MOTION, onDragRelease,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        await act(async () => {
            flick(gesture, { translationX: 60, translationY: 40, velocityX: 700, velocityY: 200 });
        });
        expect(hook.getCurrent().translateX.value).toBe(120);
        expect(hook.getCurrent().translateY.value).toBe(200);
        expect(onDragRelease).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('settles an interrupted finger drag without carrying its throw', async () => {
        const onDragRelease = vi.fn();
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds, initialPoint: { x: 120, y: 200 }, noDragRegions: [],
            releaseMotion: VOICE_ORB_RELEASE_MOTION, onDragRelease,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        await act(async () => {
            gesture.__handlers.onBegin?.({ absoluteX: 120, absoluteY: 200 });
            gesture.__handlers.onUpdate?.({ translationX: 30, translationY: -20 });
            gesture.__handlers.onFinalize?.({ velocityX: 1000, velocityY: 800 }, false);
        });
        expect(onDragRelease).toHaveBeenCalledWith({ velocityX: 0, velocityY: 0, target: { x: 150, y: 180 } });
        await hook.unmount();
    });
    it('measures exclusions at touch admission after their host moves, in absolute screen coordinates', async () => {
        // A native ref is opaque outside Reanimated; this boundary supplies its current OS measurement.
        const nativeRef = (() => 1) as unknown as import('react-native-reanimated').AnimatedRef<import('react-native').View>;
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds, initialPoint: { x: 120, y: 200 },
            noDragRegions: [{ id: 'transport', x: 10, y: 15, width: 80, height: 60, nativeRef }],
            releaseMotion: VOICE_ORB_RELEASE_MOTION,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        const fail = vi.fn();
        measurements.set(nativeRef, { pageX: 320, pageY: 480, width: 80, height: 60 });
        await act(async () => {
            gesture.__handlers.onTouchesDown?.({ allTouches: [{ x: 10, y: 15, absoluteX: 335, absoluteY: 495 }] }, { fail });
            gesture.__handlers.onBegin?.({ x: 10, y: 15, absoluteX: 335, absoluteY: 495 });
            gesture.__handlers.onUpdate?.({ translationX: 60, translationY: 45 });
        });
        expect(fail).toHaveBeenCalledOnce();
        expect(hook.getCurrent().translateX.value).toBe(120);
        // The same region moved with its parent spring: no JS re-layout or stale rect needed.
        measurements.set(nativeRef, { pageX: 400, pageY: 550, width: 80, height: 60 });
        fail.mockClear();
        await act(async () => {
            gesture.__handlers.onTouchesDown?.({ allTouches: [{ absoluteX: 335, absoluteY: 495 }] }, { fail });
            gesture.__handlers.onBegin?.({ absoluteX: 335, absoluteY: 495 });
            gesture.__handlers.onUpdate?.({ translationX: 60, translationY: 45 });
        });
        expect(fail).not.toHaveBeenCalled();
        expect(hook.getCurrent().translateX.value).toBe(180);
        expect(hook.getCurrent().translateY.value).toBe(245);
        await hook.unmount();
    });
    it('fails recognition for a screen-space control before pan can cancel its tap', async () => {
        const hook = await renderHook(() => useCompanionNativePanGesture({
            bounds, initialPoint: { x: 120, y: 200 },
            noDragRegions: [{ id: 'transport', x: 220, y: 280, width: 80, height: 60 }],
            releaseMotion: VOICE_ORB_RELEASE_MOTION,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        const fail = vi.fn();
        await act(async () => {
            gesture.__handlers.onTouchesDown?.({ allTouches: [{ x: 12, y: 15, absoluteX: 230, absoluteY: 290 }] }, { fail });
            gesture.__handlers.onBegin?.({ x: 12, y: 15, absoluteX: 230, absoluteY: 290 });
            gesture.__handlers.onUpdate?.({ translationX: 70, translationY: 60 });
            gesture.__handlers.onEnd?.({ translationX: 70, translationY: 60 });
        });
        expect(fail).toHaveBeenCalledOnce();
        expect(hook.getCurrent().translateX.value).toBe(120);
        expect(hook.getCurrent().translateY.value).toBe(200);
        expect(hook.getCurrent().shouldSuppressPress()).toBe(false);
        await hook.unmount();
    });

    it('keeps shared-only motion off React while publishing the final release position', async () => {
        let renders = 0;
        const onDragRelease = vi.fn();
        const hook = await renderHook(() => {
            renders++;
            return useCompanionNativePanGesture({
                bounds, initialPoint: { x: 120, y: 200 }, noDragRegions: [],
                releaseMotion: VOICE_ORB_RELEASE_MOTION,
                positionPublication: 'release', onDragRelease,
            });
        });
        const before = renders;
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        await act(async () => { gesture.__handlers.onBegin?.({ absoluteX: 120, absoluteY: 200 }); });
        for (let i = 1; i <= 20; i++) {
            await act(async () => { gesture.__handlers.onUpdate?.({ translationX: i, translationY: -i }); });
        }
        expect(hook.getCurrent().translateX.value).toBe(140);
        expect(hook.getCurrent().translateY.value).toBe(180);
        expect(renders).toBe(before);
        await act(async () => { gesture.__handlers.onEnd?.({ translationX: 20, translationY: -20 }); });
        expect(onDragRelease).toHaveBeenCalledWith({ velocityX: 0, velocityY: 0, target: { x: 140, y: 180 } });
        expect(hook.getCurrent().point).toEqual({ x: 140, y: 180 });
        await hook.unmount();
    });
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
