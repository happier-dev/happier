import { describe, expect, it, vi } from 'vitest';

import { scheduleProviderAuthenticationRefreshes } from './scheduleProviderAuthenticationRefreshes';

describe('scheduleProviderAuthenticationRefreshes', () => {
    it('runs the immediate and delayed refresh attempts', () => {
        vi.useFakeTimers();
        try {
            const refresh = vi.fn();

            scheduleProviderAuthenticationRefreshes({
                refresh,
                delaysMs: [0, 100, 300],
            });

            expect(refresh).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(100);
            expect(refresh).toHaveBeenCalledTimes(2);

            vi.advanceTimersByTime(200);
            expect(refresh).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels pending delayed refresh attempts', () => {
        vi.useFakeTimers();
        try {
            const refresh = vi.fn();

            const cancel = scheduleProviderAuthenticationRefreshes({
                refresh,
                delaysMs: [0, 100, 300],
            });

            expect(refresh).toHaveBeenCalledTimes(1);
            cancel();

            vi.advanceTimersByTime(1_000);
            expect(refresh).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
