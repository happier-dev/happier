import { describe, expect, it } from 'vitest';

import {
    createNearViewportTracker,
    createScrollViewNearViewportTracker,
    isSpanNearViewport,
    quantizeScrollOffset,
    resolveNearViewportWindow,
} from './nearViewport';

function scrollTo(tracker: ReturnType<typeof createNearViewportTracker>, y: number) {
    tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } } as never);
}

describe('near-viewport window', () => {
    it('measures against the native inner view ref rather than its numeric native node handle', async () => {
        const content = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, -100, 800, 6000) };
        const card = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 100, 400, 260) };
        const tracker = createScrollViewNearViewportTracker({ current: { getInnerViewRef: () => content, getInnerViewNode: () => 42 } }, false);
        expect(await tracker.measureSpan(card)).toEqual({ top: 200, height: 260 });
    });
    it('uses the same demand window along a horizontal Canvas axis', () => {
        const tracker = createNearViewportTracker({ quantum: 24, initialViewportHeight: 0, axis: 'x' });
        tracker.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 200 } } } as never);
        expect(isSpanNearViewport(tracker.getWindow(), { top: 4000, height: 400 })).toBe(false);
        tracker.onScroll({ nativeEvent: { contentOffset: { x: 4000, y: 0 } } } as never);
        expect(isSpanNearViewport(tracker.getWindow(), { top: 4000, height: 400 })).toBe(true);
        expect(isSpanNearViewport(tracker.getWindow(), { top: 0, height: 400 })).toBe(false);
    });
    it('can track only the visible window for retained presentation without widget overscan', () => {
        const tracker = createNearViewportTracker({ quantum: 1, initialViewportHeight: 800, overscan: false });
        expect(isSpanNearViewport(tracker.getWindow(), { top: 0, height: 200 })).toBe(true);
        scrollTo(tracker, 201);
        expect(isSpanNearViewport(tracker.getWindow(), { top: 0, height: 200 })).toBe(false);
        scrollTo(tracker, 0);
        expect(isSpanNearViewport(tracker.getWindow(), { top: 0, height: 200 })).toBe(true);
    });
    it('keeps one viewport of overscan above and two below the quantized scroll position', () => {
        const window = resolveNearViewportWindow({ windowTopOffset: 1000, viewportHeight: 800, quantum: 100 });
        expect(window).toEqual({ top: 200, bottom: 2700 });
        // Just inside either edge, and just outside.
        expect(isSpanNearViewport(window, { top: 100, height: 101 })).toBe(true);
        expect(isSpanNearViewport(window, { top: 0, height: 199 })).toBe(false);
        expect(isSpanNearViewport(window, { top: 2700, height: 50 })).toBe(true);
        expect(isSpanNearViewport(window, { top: 2701, height: 50 })).toBe(false);
    });

    it('treats an unmeasured body by its lower-bound start, and an unknown viewport as all eligible', () => {
        const window = resolveNearViewportWindow({ windowTopOffset: 0, viewportHeight: 800, quantum: 100 });
        expect(isSpanNearViewport(window, { top: 1700 })).toBe(true);
        expect(isSpanNearViewport(window, { top: 1701 })).toBe(false);
        expect(resolveNearViewportWindow({ windowTopOffset: 0, viewportHeight: 0, quantum: 100 })).toBeNull();
        expect(isSpanNearViewport(null, { top: 99_999, height: 10 })).toBe(true);
    });

    it('quantizes a scroll so a flick advances the window once per item', () => {
        expect(quantizeScrollOffset(0, 44)).toBe(0);
        expect(quantizeScrollOffset(43.9, 44)).toBe(0);
        expect(quantizeScrollOffset(44, 44)).toBe(44);
        expect(quantizeScrollOffset(-30, 44)).toBe(0);
    });

    it('notifies its subscribers only when the quantized window actually moves', () => {
        const tracker = createNearViewportTracker({ quantum: 100, initialViewportHeight: 800 });
        let notifications = 0;
        tracker.subscribe(() => { notifications += 1; });

        scrollTo(tracker, 40);
        scrollTo(tracker, 99);
        expect(notifications).toBe(0);
        scrollTo(tracker, 100);
        expect(notifications).toBe(1);
        expect(tracker.getWindow()).toEqual({ top: -700, bottom: 1800 });

        tracker.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } } } as never);
        expect(notifications).toBe(2);
        tracker.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 500, height: 600 } } } as never);
        expect(notifications).toBe(2);
    });
});
