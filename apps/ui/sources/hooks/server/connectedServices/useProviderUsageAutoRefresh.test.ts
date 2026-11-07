import { describe, expect, it } from 'vitest';

import { resolveProviderUsageAutoRefreshMs } from './useProviderUsageAutoRefresh';

describe('resolveProviderUsageAutoRefreshMs', () => {
    it('defaults to five minutes and honours a positive setting', () => {
        expect(resolveProviderUsageAutoRefreshMs(undefined)).toBe(5 * 60_000);
        expect(resolveProviderUsageAutoRefreshMs(0)).toBe(5 * 60_000);
        expect(resolveProviderUsageAutoRefreshMs(10)).toBe(10 * 60_000);
    });

    it('never goes below one minute', () => {
        expect(resolveProviderUsageAutoRefreshMs(0.1)).toBe(60_000);
    });
});
