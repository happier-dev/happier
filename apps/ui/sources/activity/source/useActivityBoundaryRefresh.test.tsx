import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { useActivityBoundaryRefresh } from './useActivityBoundaryRefresh';

afterEach(() => { vi.useRealTimers(); });

it('keeps a distant boundary scheduled through the platform timer range and refreshes only when due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const refresh = vi.fn();
    const deadline = Date.now() + 2_147_483_647 + 1_000;
    const hook = await renderHook(() => useActivityBoundaryRefresh(deadline, refresh));
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(2_147_483_647); });
        expect(refresh).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    } finally { await hook.unmount(); }
});
