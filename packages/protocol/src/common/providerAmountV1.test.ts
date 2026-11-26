import { expect, it } from 'vitest';

import { containsPriceTextV1 } from './providerAmountV1.js';

it('scans long grouped digits without a currency in under 500 ms', () => {
    const text = '1,'.repeat(50_000) + 'x';
    const start = performance.now();
    expect(containsPriceTextV1(text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
}, 60_000);
