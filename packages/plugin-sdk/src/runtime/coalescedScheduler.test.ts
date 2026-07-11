import { describe, expect, it, vi } from 'vitest';

import { createCoalescedScheduler } from './coalescedScheduler.js';

describe('createCoalescedScheduler', () => {
    it('coalesces triggers that arrive while a drain is active into one follow-up drain', async () => {
        let releaseFirstDrain!: () => void;
        const firstDrain = new Promise<void>((resolve) => {
            releaseFirstDrain = resolve;
        });
        const drain = vi.fn(async () => {
            if (drain.mock.calls.length === 1) {
                await firstDrain;
            }
        });

        const scheduler = createCoalescedScheduler({ drain });
        scheduler.trigger();
        scheduler.trigger();
        scheduler.trigger();
        expect(drain).toHaveBeenCalledTimes(1);

        releaseFirstDrain();
        await vi.waitFor(() => {
            expect(drain).toHaveBeenCalledTimes(2);
        });

        scheduler.dispose();
    });

    it('does not start new drains after disposal', async () => {
        const drain = vi.fn(async () => {});
        const scheduler = createCoalescedScheduler({ drain });

        scheduler.dispose();
        scheduler.trigger();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(drain).not.toHaveBeenCalled();
    });

    it('flush waits for the active drain and one queued follow-up to finish', async () => {
        let releaseFirstDrain!: () => void;
        const firstDrain = new Promise<void>((resolve) => {
            releaseFirstDrain = resolve;
        });
        const drain = vi.fn(async () => {
            if (drain.mock.calls.length === 1) await firstDrain;
        });
        const scheduler = createCoalescedScheduler({ drain });

        scheduler.trigger();
        let flushed = false;
        const flushPromise = scheduler.flush().then(() => {
            flushed = true;
        });
        await Promise.resolve();
        expect(flushed).toBe(false);

        releaseFirstDrain();
        await flushPromise;

        expect(drain).toHaveBeenCalledTimes(2);
        expect(flushed).toBe(true);
        scheduler.dispose();
    });
});
