import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceRefreshLoop } from './startConnectedServiceRefreshLoop';

describe('startConnectedServiceRefreshLoop', () => {
    it('runs refresh ticks on the configured interval', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError: vi.fn(),
            });

            expect(handle).not.toBeNull();
            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('pauses ticks until resume() is called', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError: vi.fn(),
            });

            handle?.pause();
            await vi.advanceTimersByTimeAsync(150);
            expect(coordinator.tickOnce).not.toHaveBeenCalled();

            handle?.resume();
            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
