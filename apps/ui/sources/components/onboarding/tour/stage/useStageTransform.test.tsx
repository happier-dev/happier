import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import {
    STAGE_CAMERA_MAX_SCALE,
    STAGE_CAMERA_MIN_SCALE,
    clampProgress,
    resolveStageCrossfadeFrameStyles,
    resolveStageCameraTransform,
    useStageTransform,
} from './useStageTransform';

describe('resolveStageCameraTransform', () => {
    it('centers a spotlight rect using container-relative pixels', () => {
        expect(resolveStageCameraTransform({
            containerWidth: 1000,
            containerHeight: 500,
            targetRect: { x: 700, y: 100, width: 100, height: 100 },
            zoom: 2,
            reducedMotion: false,
        })).toEqual({
            mode: 'camera',
            scale: 2,
            translateX: -500,
            translateY: 200,
        });
    });

    it('clamps zoom to the stage camera scale bounds', () => {
        expect(resolveStageCameraTransform({
            containerWidth: 1000,
            containerHeight: 500,
            targetRect: null,
            zoom: 0.4,
            reducedMotion: false,
        }).scale).toBe(STAGE_CAMERA_MIN_SCALE);

        expect(resolveStageCameraTransform({
            containerWidth: 1000,
            containerHeight: 500,
            targetRect: null,
            zoom: 4,
            reducedMotion: false,
        }).scale).toBe(STAGE_CAMERA_MAX_SCALE);
    });

    it('selects a crossfade path without camera movement under reduced motion', () => {
        expect(resolveStageCameraTransform({
            containerWidth: 1000,
            containerHeight: 500,
            targetRect: { x: 700, y: 100, width: 100, height: 100 },
            zoom: 2,
            reducedMotion: true,
        })).toEqual({
            mode: 'crossfade',
            scale: 1,
            translateX: 0,
            translateY: 0,
        });
    });
});

describe('useStageTransform', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('returns transform-only animated styles for the camera path', async () => {
        const hook = await renderHook((props) => useStageTransform(props), {
            initialProps: {
                frameId: 'session-detail',
                containerWidth: 1000,
                containerHeight: 500,
                targetRect: { x: 700, y: 100, width: 100, height: 100 },
                zoom: 2,
                reducedMotion: false,
            },
        });

        expect(hook.getCurrent().mode).toBe('camera');
        expect(hook.getCurrent().outerAnimatedStyle).toEqual({
            transform: [
                { translateX: -500 },
                { translateY: 200 },
            ],
        });
        expect(hook.getCurrent().innerAnimatedStyle).toEqual({
            transform: [{ scale: 2 }],
        });
    });

    it('resolves real incoming and outgoing opacity during reduced-motion frame changes', () => {
        expect(resolveStageCrossfadeFrameStyles(0.25)).toEqual({
            incoming: { opacity: 0.25 },
            outgoing: { opacity: 0.75 },
        });
    });

    it('keeps helpers called from animated styles native-worklet safe', () => {
        expect(clampProgress.toString()).toMatch(/["']worklet["']/);
        expect(resolveStageCrossfadeFrameStyles.toString()).toMatch(/["']worklet["']/);
    });

    it('uses reduced-motion crossfade styles and static camera', async () => {
        const hook = await renderHook((props) => useStageTransform(props), {
            initialProps: {
                frameId: 'session-detail',
                containerWidth: 1000,
                containerHeight: 500,
                targetRect: { x: 700, y: 100, width: 100, height: 100 },
                zoom: 2,
                reducedMotion: true,
            },
        });

        expect(hook.getCurrent().mode).toBe('crossfade');
        expect(hook.getCurrent().outerAnimatedStyle).toEqual({
            transform: [
                { translateX: 0 },
                { translateY: 0 },
            ],
        });
        expect(hook.getCurrent().innerAnimatedStyle).toEqual({
            transform: [{ scale: 1 }],
        });
        expect(hook.getCurrent().incomingCrossfadeAnimatedStyle).toEqual({ opacity: 1 });
        expect(hook.getCurrent().outgoingCrossfadeAnimatedStyle).toEqual({ opacity: 0 });
    });
});
