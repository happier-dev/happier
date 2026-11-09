// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPdfTouchZoom } from './pdfTouchZoom';

type Point = readonly [number, number];
function touch(target: HTMLElement, type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', touches: readonly Point[], changed: readonly Point[] = touches) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const list = (points: readonly Point[]) => points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY }));
    Object.defineProperty(event, 'touches', { value: list(touches) });
    Object.defineProperty(event, 'changedTouches', { value: list(changed) });
    target.dispatchEvent(event);
    return event;
}

describe('PDF touch zoom recognizer', () => {
    const target = document.createElement('div');
    const log: string[] = [];
    let detach = () => {};
    beforeEach(() => {
        vi.useFakeTimers({ now: 1_000 });
        log.length = 0;
        detach = attachPdfTouchZoom(target, {
            onPinch: (factor, focal) => log.push(`pinch ${factor.toFixed(2)} @${focal.x},${focal.y}`),
            onPinchEnd: (factor, focal) => log.push(`end ${factor.toFixed(2)} @${focal.x},${focal.y}`),
            onPinchCancel: () => log.push('cancel'),
            onDoubleTap: focal => log.push(`double @${focal.x},${focal.y}`),
        });
    });
    afterEach(() => { detach(); vi.useRealTimers(); });

    it('scales by the finger distance about the starting midpoint and commits the last update when a finger lifts', () => {
        touch(target, 'touchstart', [[100, 200], [200, 200]]);
        const move = touch(target, 'touchmove', [[50, 200], [250, 200]]);
        expect(move.defaultPrevented).toBe(true);
        touch(target, 'touchmove', [[0, 200], [300, 200]]);
        // The lifting finger's own final sample is not a pinch update.
        touch(target, 'touchend', [[300, 200]], [[0, 200]]);
        expect(log).toEqual(['pinch 2.00 @150,200', 'pinch 3.00 @150,200', 'end 3.00 @150,200']);
    });
    it('does not treat the finger left on the screen after a pinch as a tap', () => {
        touch(target, 'touchstart', [[100, 200], [200, 200]]);
        touch(target, 'touchend', [[200, 200]], [[100, 200]]);
        log.length = 0;
        for (let i = 0; i < 2; i++) { touch(target, 'touchend', [], [[200, 200]]); vi.advanceTimersByTime(50); }
        expect(log).toEqual([]);
    });
    it('treats a lone finger going down after a pinch as a fresh gesture even when the last lift was never reported', () => {
        touch(target, 'touchstart', [[100, 200], [200, 200]]);
        touch(target, 'touchend', [[200, 200]], [[100, 200]]);
        log.length = 0;
        const tap = () => { touch(target, 'touchstart', [[120, 300]]); touch(target, 'touchend', [], [[120, 300]]); };
        tap(); vi.advanceTimersByTime(80); tap();
        expect(log).toEqual(['double @120,300']);
    });
    it('cancels a pinch the system takes away', () => {
        touch(target, 'touchstart', [[100, 200], [200, 200]]);
        touch(target, 'touchmove', [[50, 200], [250, 200]]);
        touch(target, 'touchcancel', []);
        expect(log).toEqual(['pinch 2.00 @150,200', 'cancel']);
    });
    it('leaves one-finger scrolling alone', () => {
        touch(target, 'touchstart', [[100, 200]]);
        const move = touch(target, 'touchmove', [[100, 120]]);
        expect(move.defaultPrevented).toBe(false);
        touch(target, 'touchend', [], [[100, 120]]);
        expect(log).toEqual([]);
    });
    it('reports a double tap only for two quick taps in the same place', () => {
        const tap = (point: Point) => { touch(target, 'touchstart', [point]); return touch(target, 'touchend', [], [point]); };
        tap([120, 300]);
        vi.advanceTimersByTime(120);
        expect(tap([124, 296]).defaultPrevented).toBe(true);
        expect(log).toEqual(['double @124,296']);
        // A third tap starts a fresh pair.
        vi.advanceTimersByTime(120);
        tap([120, 300]);
        expect(log).toEqual(['double @124,296']);
    });
    it('ignores slow, distant and dragged taps', () => {
        const tap = (point: Point) => { touch(target, 'touchstart', [point]); touch(target, 'touchend', [], [point]); };
        tap([120, 300]); vi.advanceTimersByTime(400); tap([120, 300]);
        vi.advanceTimersByTime(1000);
        tap([120, 300]); vi.advanceTimersByTime(100); tap([220, 300]);
        vi.advanceTimersByTime(1000);
        tap([120, 300]);
        vi.advanceTimersByTime(100);
        touch(target, 'touchstart', [[120, 300]]); touch(target, 'touchmove', [[120, 340]]); touch(target, 'touchend', [], [[120, 340]]);
        expect(log).toEqual([]);
    });
    it('stops listening when detached', () => {
        detach();
        touch(target, 'touchstart', [[100, 200], [200, 200]]);
        touch(target, 'touchmove', [[50, 200], [250, 200]]);
        expect(log).toEqual([]);
    });
});
