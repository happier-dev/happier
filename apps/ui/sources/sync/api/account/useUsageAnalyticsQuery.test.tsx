import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { UsageResponse } from './apiUsage';

const getUsageForPeriodSpy = vi.hoisted(() => vi.fn());

vi.mock('./apiUsage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./apiUsage')>();
    return {
        ...actual,
        getUsageForPeriod: getUsageForPeriodSpy,
    };
});

const credentials: AuthCredentials = {
    token: 'test-token',
    secret: 'test-secret',
};

const response: UsageResponse = [];

afterEach(async () => {
    const { invalidateUsageAnalyticsQueryCache } = await import('./useUsageAnalyticsQuery');
    invalidateUsageAnalyticsQueryCache();
    getUsageForPeriodSpy.mockReset();
    standardCleanup();
    vi.useRealTimers();
});

describe('useUsageAnalyticsQuery', () => {
    it('shares one in-flight request and cached response between two consumers', async () => {
        getUsageForPeriodSpy.mockResolvedValue(response);
        const { useUsageAnalyticsQuery } = await import('./useUsageAnalyticsQuery');

        const hook = await renderHook(() => ({
            first: useUsageAnalyticsQuery({ credentials, enabled: true, period: '30days' }),
            second: useUsageAnalyticsQuery({ credentials, enabled: true, period: '30days' }),
        }));

        expect(getUsageForPeriodSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().first.data).toBe(response);
        expect(hook.getCurrent().second.data).toBe(response);
    });

    it('refetches after the 60 second cache TTL expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T20:00:00Z'));
        getUsageForPeriodSpy.mockResolvedValue(response);
        const { useUsageAnalyticsQuery } = await import('./useUsageAnalyticsQuery');

        const first = await renderHook(() => useUsageAnalyticsQuery({
            credentials,
            enabled: true,
            period: '30days',
        }));
        await first.unmount();
        await vi.advanceTimersByTimeAsync(60_001);
        await renderHook(() => useUsageAnalyticsQuery({
            credentials,
            enabled: true,
            period: '30days',
        }));

        expect(getUsageForPeriodSpy).toHaveBeenCalledTimes(2);
    });

    it('invalidates and refetches when reloadToken changes', async () => {
        getUsageForPeriodSpy.mockResolvedValue(response);
        const { useUsageAnalyticsQuery } = await import('./useUsageAnalyticsQuery');

        const hook = await renderHook(
            ({ reloadToken }: { reloadToken: number }) => useUsageAnalyticsQuery({
                credentials,
                enabled: true,
                period: '30days',
                reloadToken,
            }),
            { initialProps: { reloadToken: 0 } },
        );
        await hook.rerender({ reloadToken: 1 });

        expect(getUsageForPeriodSpy).toHaveBeenCalledTimes(2);
    });
});
