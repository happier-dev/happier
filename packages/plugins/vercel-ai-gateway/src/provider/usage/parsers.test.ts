import { describe, expect, it } from 'vitest';
import { parseVercelCredits } from './parsers.js';

describe('Vercel usage', () => {
  it('decodes denominated USD decimal strings including negative balance without inventing a cap', () => {
    expect(parseVercelCredits({ balance: '-0.25', total_used: '1.75' }).meters).toMatchObject([
      { meterId: 'balance', remaining: -0.25, used: null, limit: null, unit: 'usd', currency: 'USD', utilizationPct: null },
      { meterId: 'spend-lifetime', used: 1.75, limit: null, unit: 'usd', currency: 'USD', utilizationPct: null },
    ]);
    for (const balance of ['', '  ', 'NaN', 'Infinity', '0x10', 4, null]) {
      expect(() => parseVercelCredits({ balance, total_used: '1' })).toThrow();
    }
  });
});
