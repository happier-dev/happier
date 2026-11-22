import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSocketApplyFrameScheduler } from './socketApplyFrame';

// The frame source (requestAnimationFrame) and host visibility are platform boundaries.
function createFramePump(painting = true) {
    const callbacks: Array<() => void> = [];
    const scheduler = createSocketApplyFrameScheduler({
        requestFrame: () => (callback) => { callbacks.push(callback); },
        isPainting: () => painting,
    });
    return {
        scheduler,
        pendingFrames: () => callbacks.length,
        frame: () => {
            for (const callback of callbacks.splice(0)) callback();
        },
    };
}

describe('createSocketApplyFrameScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs every task scheduled within one frame in that one frame, in scheduling order', () => {
        const pump = createFramePump();
        const ran: string[] = [];
        pump.scheduler.schedule(() => ran.push('sessions'), 16);
        pump.scheduler.schedule(() => ran.push('messages:s1'), 16);
        pump.scheduler.schedule(() => ran.push('messages:s2'), 0);

        expect(ran).toEqual([]);
        expect(pump.pendingFrames()).toBe(1);

        pump.frame();

        expect(ran).toEqual(['sessions', 'messages:s1', 'messages:s2']);
        pump.frame();
        expect(ran).toHaveLength(3);
    });

    it('flushNow runs scheduled tasks at once and the frame that follows runs nothing again', () => {
        const pump = createFramePump();
        const ran: string[] = [];
        pump.scheduler.schedule(() => ran.push('a'), 16);
        pump.scheduler.schedule(() => ran.push('windowed'), 100);

        pump.scheduler.flushNow();
        expect(ran).toEqual(['a', 'windowed']);

        pump.frame();
        vi.runAllTimers();
        pump.frame();
        expect(ran).toEqual(['a', 'windowed']);
    });

    it('holds a longer configured window, then applies at the next frame', () => {
        const pump = createFramePump();
        const ran: string[] = [];
        pump.scheduler.schedule(() => ran.push('windowed'), 100);

        expect(pump.pendingFrames()).toBe(0);
        vi.advanceTimersByTime(83);
        expect(pump.pendingFrames()).toBe(0);
        vi.advanceTimersByTime(1);
        expect(pump.pendingFrames()).toBe(1);
        expect(ran).toEqual([]);

        pump.frame();
        expect(ran).toEqual(['windowed']);
    });

    it('keeps applying on a one-frame timer while the host is not painting', () => {
        const pump = createFramePump(false);
        const ran: string[] = [];
        pump.scheduler.schedule(() => ran.push('hidden'), 16);

        expect(pump.pendingFrames()).toBe(0);
        vi.advanceTimersByTime(16);
        expect(ran).toEqual(['hidden']);
    });

    it('does not run a cancelled task, and a failing task does not drop the others', () => {
        const pump = createFramePump();
        const ran: string[] = [];
        const cancel = pump.scheduler.schedule(() => ran.push('cancelled'), 16);
        pump.scheduler.schedule(() => { throw new Error('boom'); }, 16);
        pump.scheduler.schedule(() => ran.push('kept'), 16);
        cancel();

        expect(() => pump.frame()).toThrow('boom');
        expect(ran).toEqual(['kept']);
    });
});
