import { afterEach, describe, expect, it, vi } from 'vitest';
import { armDeadlineTimer } from './deadlineTimer.js';

afterEach(() => vi.useRealTimers());

describe('armDeadlineTimer', () => {
    it('rearms across multiple timer chunks and fires only at the full caller deadline', async () => {
        vi.useFakeTimers();
        const delayMs = 2 * 2_147_483_647 + 100;
        const reached = vi.fn();
        const cancel = armDeadlineTimer(Date.now() + delayMs, reached);
        try {
            await vi.advanceTimersByTimeAsync(delayMs - 1);
            expect(reached).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(reached).toHaveBeenCalledTimes(1);
        } finally { cancel(); }
    });

    it('cancels the rearmed chunk without leaving a pending deadline', async () => {
        vi.useFakeTimers();
        const reached = vi.fn();
        const cancel = armDeadlineTimer(Date.now() + 2_147_483_647 + 100, reached, { unref: true });
        await vi.advanceTimersByTimeAsync(2_147_483_647);
        cancel();
        await vi.advanceTimersByTimeAsync(100);
        expect(reached).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
