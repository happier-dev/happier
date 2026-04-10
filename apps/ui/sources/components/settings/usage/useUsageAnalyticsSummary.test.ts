import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => key === 'errors.unknownError' ? 'Unknown error' : key,
}));

describe('resolveUsageSummaryErrorMessage', () => {
    it('uses a fallback message for unexpected errors', async () => {
        const { resolveUsageSummaryErrorMessage } = await import('./useUsageAnalyticsSummary');

        expect(resolveUsageSummaryErrorMessage(new Error('boom'))).toBe('Unknown error');
    });
});
