import { describe, expect, it, vi } from 'vitest';

import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const textMock = createTextModuleMock({
    translate: (key: string) => (key === 'errors.unknownError' ? 'Unknown error' : key),
});

vi.mock('@/text', () => textMock);

describe('resolveUsageSummaryErrorMessage', () => {
    it('uses a fallback message for unexpected errors', async () => {
        const { resolveUsageSummaryErrorMessage } = await import('./useUsageAnalyticsSummary');

        expect(resolveUsageSummaryErrorMessage(new Error('boom'))).toBe('Unknown error');
    });
});
