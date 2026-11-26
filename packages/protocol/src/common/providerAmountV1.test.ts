import { expect, it } from 'vitest';

import { containsPriceTextV1 } from './providerAmountV1.js';

it.each(['USD 1,234,567,890.50', 'INR 1,23,45,678.00', 'Credit: $-5', 'USD -10', 'EUR 1.234.567,89',
    '1,234,567,890.50 USD', '10USD', 'usd10', '10 dollars'])('detects the price in %s', text => {
    expect(containsPriceTextV1(text)).toBe(true);
});

it.each(['Next.js 15.2', 'CAD 2.5D', 'v1.2.3', 'try 3 options'])('preserves technical prose in %s', text => {
    expect(containsPriceTextV1(text)).toBe(false);
});

it.each(['1,', '-1,', '$-'])('scans repeated %s in under 50 ms at 100k characters', chunk => {
    const text = chunk.repeat(Math.ceil(100_000 / chunk.length)) + 'x';
    const start = performance.now();
    const found = containsPriceTextV1(text);
    const elapsed = performance.now() - start;
    expect(found).toBe(false);
    expect(elapsed).toBeLessThan(50);
});
