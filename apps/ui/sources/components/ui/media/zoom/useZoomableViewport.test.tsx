import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { useZoomableViewport } from './useZoomableViewport';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// Native recognizers are a system boundary; the canonical adapter records their callbacks.
type RecordedGesture = {
    __config?: { testId?: string };
    __handlers?: Record<string, (event: Record<string, number>, success?: boolean) => void>;
    gestures?: RecordedGesture[];
};
function recognizer(gesture: unknown, id: string): RecordedGesture {
    const root = gesture as RecordedGesture;
    if (root.__config?.testId === id) return root;
    for (const child of root.gestures ?? []) {
        try { return recognizer(child, id); } catch { /* Another recognizer in the composition. */ }
    }
    throw new Error(`No recognizer ${id}`);
}

describe('zoom gesture arbitration', () => {
    it('refits on viewport changes and retains a user zoom and its centre content point', async () => {
        let current: ReturnType<typeof useZoomableViewport> | undefined;
        function Harness({ viewportSize }: { viewportSize: { width: number; height: number } }) {
            current = useZoomableViewport({
                imageSize: { width: 2000, height: 1000 }, viewportSize,
                devicePixelRatio: 1, reducedMotion: true,
            });
            return null;
        }
        const screen = await renderScreen(<Harness viewportSize={{ width: 1376, height: 756 }} />);
        await screen.update(<Harness viewportSize={{ width: 358, height: 844 }} />);
        expect(current!.scale.value).toBeCloseTo(358 / 2000);
        expect(current!.translationX.value).toBe(0);
        expect(current!.translationY.value).toBe(0);

        // The existing zoomed-resize contract keeps image pixels and the centre content point,
        // clamping only when the new viewport cannot pan that far.
        await act(async () => {
            current!.actual();
            current!.wheelHandlers.onPan({ x: 100, y: 50 });
        });
        await screen.update(<Harness viewportSize={{ width: 812, height: 390 }} />);
        expect(current!.scale.value).toBe(1);
        expect(current!.translationX.value / current!.scale.value).toBe(100);
        expect(current!.translationY.value / current!.scale.value).toBe(50);
        await screen.unmount();
    });

    it('returns a cancelled gallery drag and pages only when the stroke started at the pan edge', async () => {
        const onPage = vi.fn();
        let current: ReturnType<typeof useZoomableViewport> | undefined;
        function Harness() {
            current = useZoomableViewport({ imageSize: { width: 1000, height: 1000 }, viewportSize: { width: 500, height: 500 }, devicePixelRatio: 1, reducedMotion: true, onPage });
            return null;
        }
        await renderScreen(<Harness />);
        const pan = recognizer(current!.gesture, 'media-pan').__handlers!;
        await act(async () => {
            pan.onStart({});
            pan.onUpdate({ translationX: 200, translationY: 0, numberOfPointers: 1 });
        });
        expect(current!.pageTranslation.value).toBe(200);
        await act(async () => pan.onFinalize({}, false));
        expect(current!.pageTranslation.value).toBe(0);
        await act(async () => current!.actual());
        const swipe = () => act(async () => {
            pan.onStart({});
            pan.onUpdate({ translationX: 300, translationY: 0, numberOfPointers: 1 });
            pan.onEnd({ translationX: 300, translationY: 0, velocityX: 0, velocityY: 0 });
            pan.onFinalize({}, true);
        });
        await swipe();
        expect(onPage).not.toHaveBeenCalled();
        await swipe();
        expect(onPage).toHaveBeenCalledWith(-1, 0);
    });

    it('ignores a lifted pinch finger and reserves dismiss for a vertical fit gesture', async () => {
        const onDismiss = vi.fn();
        const onPage = vi.fn();
        const onZoomSettled = vi.fn();
        let current: ReturnType<typeof useZoomableViewport> | undefined;
        function Harness() {
            current = useZoomableViewport({
                imageSize: { width: 1000, height: 1000 }, viewportSize: { width: 500, height: 500 },
                devicePixelRatio: 1, reducedMotion: true, onDismiss, onPage, onZoomSettled,
            });
            return null;
        }
        await renderScreen(<Harness />);
        const pinch = recognizer(current!.gesture, 'media-pinch').__handlers!;
        await act(async () => pinch.onFinalize({}, false));
        expect(onZoomSettled).not.toHaveBeenCalled();
        await act(async () => {
            pinch.onStart({ focalX: 250, focalY: 250, numberOfPointers: 2 });
            pinch.onUpdate({ focalX: 250, focalY: 250, numberOfPointers: 2, scale: 2 });
        });
        expect(current!.scale.value).toBe(1);
        await act(async () => pinch.onUpdate({ focalX: 0, focalY: 0, numberOfPointers: 1, scale: 0 }));
        expect(current!.scale.value).toBe(1);
        await act(async () => pinch.onEnd({}));
        const pan = recognizer(current!.gesture, 'media-pan').__handlers!;
        await act(async () => {
            pan.onStart({ translationX: 0, translationY: 0 });
            pan.onUpdate({ translationX: 0, translationY: 200 });
            pan.onEnd({ translationX: 0, translationY: 200, velocityX: 0, velocityY: 1000 });
        });
        expect(onDismiss).not.toHaveBeenCalled();
        await act(async () => current!.fit());
        await act(async () => {
            pan.onStart({ translationX: 0, translationY: 0 });
            pan.onUpdate({ translationX: 0, translationY: 200 });
            pan.onEnd({ translationX: 0, translationY: 200, velocityX: 0, velocityY: 1000 });
        });
        expect(onDismiss).toHaveBeenCalledWith(1000);
        expect(onPage).not.toHaveBeenCalled();
    });
});
