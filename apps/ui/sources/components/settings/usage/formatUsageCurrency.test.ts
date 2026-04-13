import { describe, expect, it } from 'vitest';

import { formatUsageCurrency } from './formatUsageCurrency';

describe('formatUsageCurrency', () => {
    it('rounds large values to whole units and small values to at most two decimals', () => {
        expect(formatUsageCurrency(2777.1334, 'USD')).toBe('$2,777');
        expect(formatUsageCurrency(12.4567, 'USD')).toBe('$12.46');
        expect(formatUsageCurrency(0.1587, 'USD')).toBe('$0.16');
    });
});
