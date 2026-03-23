import { describe, expect, it, vi } from 'vitest';

import { scheduleProviderAuthenticationRefreshes } from './scheduleProviderAuthenticationRefreshes';

describe('scheduleProviderAuthenticationRefreshes', () => {
    type TimeoutCallback = Exclude<Parameters<typeof setTimeout>[0], string>;

    function createTimerHarness() {
        const timers: Array<{
            delayMs: number;
            cleared: boolean;
            run: () => void;
        }> = [];

        const setTimeoutFn = ((callback: TimeoutCallback, delay?: number) => {
            const timer = {
                delayMs: Number(delay ?? 0),
                cleared: false,
                run: () => {
                    if (!timer.cleared) {
                        callback();
                    }
                },
            };

            timers.push(timer);
            return timer as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;

        const clearTimeoutFn = ((timer: ReturnType<typeof setTimeout>) => {
            (timer as unknown as { cleared: boolean }).cleared = true;
        }) as typeof clearTimeout;

        return {
            timers,
            setTimeoutFn,
            clearTimeoutFn,
        };
    }

    it('runs the immediate and delayed refresh attempts', () => {
        const refresh = vi.fn();
        const timers = createTimerHarness();

        scheduleProviderAuthenticationRefreshes({
            refresh,
            delaysMs: [0, 100, 300],
            setTimeoutFn: timers.setTimeoutFn,
            clearTimeoutFn: timers.clearTimeoutFn,
        });

        expect(refresh).toHaveBeenCalledTimes(1);

        timers.timers.find((timer) => timer.delayMs === 100)?.run();
        expect(refresh).toHaveBeenCalledTimes(2);

        timers.timers.find((timer) => timer.delayMs === 300)?.run();
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('cancels pending delayed refresh attempts', () => {
        const refresh = vi.fn();
        const timers = createTimerHarness();

        const cancel = scheduleProviderAuthenticationRefreshes({
            refresh,
            delaysMs: [0, 100, 300],
            setTimeoutFn: timers.setTimeoutFn,
            clearTimeoutFn: timers.clearTimeoutFn,
        });

        expect(refresh).toHaveBeenCalledTimes(1);
        cancel();

        timers.timers.forEach((timer) => timer.run());
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});
