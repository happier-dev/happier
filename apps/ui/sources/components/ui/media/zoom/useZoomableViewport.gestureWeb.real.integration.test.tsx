import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useZoomableViewport } from './useZoomableViewport';

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
});

// jsdom has no layout or pointer capture. Keep the shipped web recognizers and
// the production zoom composition real beneath those browser boundaries.
function touch(target: Element, type: string, id: number, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    target.dispatchEvent(event);
}

describe('Media stage real web touch recognizers', () => {
    it('zooms around two touch pointers and settles without paging or dismissing', async () => {
        const onDismiss = vi.fn();
        const onPage = vi.fn();
        const onZoomSettled = vi.fn();
        let current: ReturnType<typeof useZoomableViewport> | undefined;
        function StageViewport() {
            current = useZoomableViewport({
                imageSize: { width: 1000, height: 1000 }, viewportSize: { width: 390, height: 600 },
                devicePixelRatio: 1, reducedMotion: true, onDismiss, onPage, onZoomSettled,
            });
            return <GestureHandlerRootView><GestureDetector gesture={current.gesture}>
                <View testID="stage-viewport" />
            </GestureDetector></GestureHandlerRootView>;
        }
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 600));
        Object.defineProperties(HTMLElement.prototype, {
            setPointerCapture: { configurable: true, value: () => {} },
            releasePointerCapture: { configurable: true, value: () => {} },
            hasPointerCapture: { configurable: true, value: () => true },
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root!.render(<StageViewport />));
        const target = container.querySelector('[data-testid="stage-viewport"]')!;
        expect(target).not.toBeNull();
        // Browsers compute the initial independent scale as "none"; jsdom
        // otherwise returns an empty string, which the recognizer parses as NaN.
        (target as HTMLElement).style.scale = 'none';
        const fit = current!.scale.value;
        await act(async () => {
            touch(target, 'pointerdown', 1, 145, 300);
            touch(target, 'pointerdown', 2, 245, 300);
            // Continue moving after the shipped recognizer's activation slop;
            // ending at activation alone leaves its initial scale unchanged.
            for (const distance of [120, 150, 200, 250, 300]) {
                touch(target, 'pointermove', 2, 195 + distance / 2, 300);
                touch(target, 'pointermove', 1, 195 - distance / 2, 300);
            }
        });
        expect(current!.scale.value).toBeGreaterThan(fit * 1.5);
        await act(async () => {
            touch(target, 'pointerup', 1, 45, 300);
            touch(target, 'pointerup', 2, 345, 300);
        });
        expect(onZoomSettled).toHaveBeenLastCalledWith(true);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(onPage).not.toHaveBeenCalled();
    });
});
