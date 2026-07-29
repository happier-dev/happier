import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import {
    resolveStageWebCameraFrame,
    resolveStageWebCameraStep,
    useStageWebCamera,
    writeStageWebMotionVisibility,
} from './useStageWebCamera';

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('resolveStageWebCameraStep', () => {
    it('approaches the target with a frame-rate-independent critically damped step', () => {
        const current = { translateX: 0, translateY: 0, scale: 1 };
        const target = { translateX: -320, translateY: 140, scale: 1.35 };

        const oneFrame = resolveStageWebCameraStep(current, target, 16.67);
        const twoHalfFrames = resolveStageWebCameraStep(
            resolveStageWebCameraStep(current, target, 8.335).transform,
            target,
            8.335,
        );

        expect(oneFrame.settled).toBe(false);
        expect(oneFrame.transform.translateX).toBeCloseTo(twoHalfFrames.transform.translateX, 5);
        expect(oneFrame.transform.translateY).toBeCloseTo(twoHalfFrames.transform.translateY, 5);
        expect(oneFrame.transform.scale).toBeCloseTo(twoHalfFrames.transform.scale, 5);
    });

    it('snaps exactly to the target inside the idle epsilon', () => {
        const target = { translateX: -320, translateY: 140, scale: 1.35 };
        const result = resolveStageWebCameraStep(
            { translateX: -319.98, translateY: 139.99, scale: 1.34999 },
            target,
            16.67,
        );

        expect(result).toEqual({ transform: target, settled: true });
    });

    it('snaps a stale animation frame to target instead of integrating a throttled delta', () => {
        const target = { translateX: -320, translateY: 140, scale: 1.35 };

        expect(resolveStageWebCameraStep(
            { translateX: 0, translateY: 0, scale: 1 },
            target,
            300,
        )).toEqual({ transform: target, settled: true });
    });

    it('projects the halo from the same intermediate transform produced by the camera tick', () => {
        const current = { translateX: 0, translateY: 0, scale: 1 };
        const target = { mode: 'camera' as const, translateX: -320, translateY: 140, scale: 1.35 };
        const sourceTargetRect = { x: 120, y: 160, width: 240, height: 120 };
        const transformBounds = { x: 0, y: 0, width: 1000, height: 500 };

        const frame = resolveStageWebCameraFrame({
            current,
            target,
            elapsedMs: 16.67,
            sourceTargetRect,
            transformBounds,
        });

        expect(frame.settled).toBe(false);
        expect(frame.haloRect).toEqual({
            x: 500 + (120 - 500) * frame.transform.scale + frame.transform.translateX,
            y: 250 + (160 - 250) * frame.transform.scale + frame.transform.translateY,
            width: 240 * frame.transform.scale,
            height: 120 * frame.transform.scale,
        });
        expect(frame.haloRect).not.toEqual({
            x: 500 + (120 - 500) * target.scale + target.translateX,
            y: 250 + (160 - 250) * target.scale + target.translateY,
            width: 240 * target.scale,
            height: 120 * target.scale,
        });
    });

    it('swaps pre-mounted live and decoded frozen layers with opacity-only writes', () => {
        const live = { style: { opacity: '1', willChange: '' } };
        const frozen = { style: { opacity: '0', willChange: '' } };

        writeStageWebMotionVisibility(live, frozen, true);
        expect(live.style).toEqual({ opacity: '0', willChange: 'opacity' });
        expect(frozen.style).toEqual({ opacity: '1', willChange: 'transform, opacity' });

        writeStageWebMotionVisibility(live, frozen, false);
        expect(live.style.opacity).toBe('1');
        expect(frozen.style.opacity).toBe('0');
    });

    it('watchdog-thaws and snap-settles when requestAnimationFrame never resumes', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 17));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('performance', { now: () => 0 });

        const outer = { style: { opacity: '1', transform: '', willChange: '' } };
        const inner = { style: { opacity: '1', transform: '', willChange: '' } };
        const live = { style: { opacity: '1', willChange: '' } };
        const frozen = { style: { opacity: '0', transform: '', willChange: '' } };
        const onMotionChange = vi.fn();
        const onSettled = vi.fn();
        const baseProps = {
            enabled: true,
            frameId: 'session-view.hero',
            target: { mode: 'camera' as const, translateX: 0, translateY: 0, scale: 1 },
            outerRef: { current: outer },
            innerRef: { current: inner },
            transformBounds: { x: 0, y: 0, width: 1000, height: 500 },
            freezeDuringMotion: true,
            liveLayerRef: { current: live },
            frozenLayerRef: { current: frozen },
            cameraNodeTranslationScale: 1,
            onMotionChange,
            onSettled,
        };
        const hook = await renderHook((props: typeof baseProps) => useStageWebCamera(props), {
            initialProps: baseProps,
        });

        await hook.rerender({
            ...baseProps,
            frameId: 'session-view.spotlight',
            target: { mode: 'camera', translateX: -320, translateY: 140, scale: 1.35 },
        });
        expect(live.style.opacity).toBe('0');
        expect(frozen.style.opacity).toBe('1');

        await vi.advanceTimersByTimeAsync(2_000);

        expect(outer.style.transform).toBe('translate3d(-320.00px, 140.00px, 0)');
        expect(inner.style.transform).toBe('scale(1.3500)');
        expect(live.style.opacity).toBe('1');
        expect(frozen.style.opacity).toBe('0');
        expect(onMotionChange).toHaveBeenLastCalledWith(false);
        expect(onSettled).toHaveBeenCalledWith('session-view.spotlight');
    });

    it('thaws and clears motion state when an in-flight camera effect is disabled', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 17));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('performance', { now: () => 0 });

        const outer = { style: { opacity: '1', transform: '', willChange: '' } };
        const inner = { style: { opacity: '1', transform: '', willChange: '' } };
        const live = { style: { opacity: '1', willChange: '' } };
        const frozen = { style: { opacity: '0', transform: '', willChange: '' } };
        const onMotionChange = vi.fn();
        const baseProps = {
            enabled: true,
            frameId: 'session-view.hero',
            target: { mode: 'camera' as const, translateX: 0, translateY: 0, scale: 1 },
            outerRef: { current: outer },
            innerRef: { current: inner },
            transformBounds: { x: 0, y: 0, width: 1000, height: 500 },
            freezeDuringMotion: true,
            liveLayerRef: { current: live },
            frozenLayerRef: { current: frozen },
            cameraNodeTranslationScale: 1,
            onMotionChange,
            onSettled: vi.fn(),
        };
        const hook = await renderHook((props: typeof baseProps) => useStageWebCamera(props), {
            initialProps: baseProps,
        });

        await hook.rerender({
            ...baseProps,
            frameId: 'session-view.spotlight',
            target: { mode: 'camera', translateX: -320, translateY: 140, scale: 1.35 },
        });
        expect(live.style.opacity).toBe('0');
        expect(frozen.style.opacity).toBe('1');
        expect(onMotionChange).toHaveBeenLastCalledWith(true);

        await hook.rerender({
            ...baseProps,
            enabled: false,
            frameId: 'session-view.spotlight',
            target: { mode: 'camera', translateX: -320, translateY: 140, scale: 1.35 },
        });

        expect(live.style.opacity).toBe('1');
        expect(frozen.style.opacity).toBe('0');
        expect(onMotionChange).toHaveBeenLastCalledWith(false);
    });
});
