import * as React from 'react';
import { act } from 'react';
import { Animated, type GestureResponderEvent, type View } from 'react-native';
import type { SkImage } from '@shopify/react-native-skia';
import { expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { readNativeStepAnchor } from './capturePressedElement.native';
import { freezeStepLayer } from './freezeLayer.native';
import { StepFreezeImage } from './StepFreezeImage.native';
import * as presentation from './stepMotionPresentation';
import { runStepMove, StepMotionStage, useStepMotionStage } from './StepMotionStage';
import type { StepMotionLayerHandle } from './stepMotionTypes';

const capture = vi.hoisted(() => ({ makeImageFromView: vi.fn() }));
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    makeImageFromView: capture.makeImageFromView,
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

it('uses the touch position and keeps the control ID when Fabric cannot measure it', () => {
    const layer = {};
    const event = {
        target: { id: 'method-back', parentElement: layer },
        nativeEvent: { pageX: 140, pageY: 260 },
    } as unknown as GestureResponderEvent;
    expect(readNativeStepAnchor(event, layer)).toEqual({
        testID: 'method-back', rect: { x: 140, y: 260, width: 0, height: 0 },
    });
});

it('releases the native image when its last visible frame clears', async () => {
    const release = vi.fn();
    let complete: () => void = () => { throw new Error('No opacity animation started'); };
    const animate = vi.spyOn(Animated, 'timing').mockImplementation(() => ({
        start: callback => { complete = () => callback?.({ finished: true }); },
        stop() {},
        reset() {},
    }));
    const rect = { x: 100, y: 200, width: 180, height: 380 };
    const image = { dispose: release } as unknown as SkImage;
    try {
        const screen = await renderScreen(<StepFreezeImage freeze={{ rect, image, release }}
            opacity={[1, 0.4, 0, 0, 0]} durationMs={1000} delayMs={0} onCleared={release} />);
        expect(animate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 500 }));
        expect(release).not.toHaveBeenCalled();
        await act(async () => { complete(); });
        expect(screen.findAll(node => String(node.type) === 'SkiaImage')).toHaveLength(0);
        expect(release).toHaveBeenCalledOnce();
    } finally {
        standardCleanup();
        animate.mockRestore();
    }
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// The readiness and clock at the native graphics boundary are driven by the fixture.
vi.mock('@/components/atmosphere/glyph/GlyphSurface', () => ({ GlyphSurface: () => null }));

it.each([false, true])('selects the native presentation in layout order (capture ready: %s)', async (early) => {
    type Stage = NonNullable<ReturnType<typeof useStepMotionStage>>;
    const current = { stage: null as Stage | null };
    function NativeHostFixture() {
        current.stage = useStepMotionStage();
        return null;
    }
    await renderScreen(<StepMotionStage><NativeHostFixture /></StepMotionStage>);
    const stage = current.stage;
    if (!stage) throw new Error('The root must mount its motion stage');

    const rect = { x: 100, y: 200, width: 180, height: 380 };
    // Fabric's measurable native view is the screenshot boundary in this test.
    const nativeView = { getBoundingClientRect: () => rect } as unknown as View;
    const dispose = vi.fn();
    const makeImage = capture.makeImageFromView.mockReset();
    let completeCapture: () => void = () => { throw new Error('No outgoing capture was started'); };
    makeImage.mockImplementation(() => new Promise(resolve => {
        completeCapture = () => { resolve({ dispose }); };
    }));
    const fadeIn = vi.fn(() => () => {});
    const layer = (): StepMotionLayerHandle => ({
        key: 'workflow', compact: false, warmOnMount: true, notice: false,
        webElement: () => null, nativeElement: () => nativeView, focal: () => null,
        focus() {}, paintOpacity: () => () => {}, fadeIn,
    });
    const outgoing = layer();
    const incoming = layer();
    let detach: (() => void) | undefined;
    try {
        await act(async () => { detach = stage.attach(outgoing); });
        stage.loadPresentation({ ...presentation, freezeStepLayer });
        stage.glyphReadiness('ready');
        const committed = vi.fn(() => {
            detach?.();
            stage.attach(incoming);
            stage.commit(incoming);
        });
        await act(async () => { runStepMove({ kind: 'step', layer: 'workflow', commit: committed }); });
        expect(committed).toHaveBeenCalledOnce();
        expect(makeImage).toHaveBeenCalledExactlyOnceWith({ current: nativeView });
        expect(fadeIn).not.toHaveBeenCalled();

        if (early) await act(async () => { completeCapture(); });
        await act(async () => { stage.laidOut(incoming); });
        expect(fadeIn).toHaveBeenCalledTimes(early ? 0 : 1);
        if (!early) await act(async () => { completeCapture(); });
        expect(dispose).toHaveBeenCalledTimes(early ? 0 : 1);

        if (early) {
            const detachBack = stage.attach({ ...layer(), key: 'method', backTestID: 'method-back' });
            // The outer view also sees this touch as it bubbles from the method form.
            await act(async () => { stage.nativeInput({ testID: 'method-back', rect }); });
            expect(dispose).not.toHaveBeenCalled();
            detachBack();
        }

        await act(async () => { stage.settle(); });
        expect(dispose).toHaveBeenCalledOnce();
        expect(makeImage).toHaveBeenCalledOnce();
    } finally {
        standardCleanup();
    }
});
