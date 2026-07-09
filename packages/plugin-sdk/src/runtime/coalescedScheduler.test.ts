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
});
