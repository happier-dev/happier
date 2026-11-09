import { describe, expect, it } from 'vitest';
import { parseOpenRouterCredits, parseOpenRouterKeyUsage, parseOpenRouterRequestCost } from './parsers.js';

describe('OpenRouter usage', () => {
  it('takes only finite nonnegative charged request USD, preserving free requests', () => {
    expect(parseOpenRouterRequestCost({ cost: 0.12, cost_details: { upstream_inference_cost: 9 } })).toBe(0.12);
    expect(parseOpenRouterRequestCost({ cost: 0 })).toBe(0);
    for (const usage of [null, [], {}, { cost: '0.12' }, { cost: -1 }, { cost: NaN }, { cost: Infinity },
      { cost_details: { upstream_inference_cost: 9 } }]) expect(parseOpenRouterRequestCost(usage)).toBeNull();
  });
  it('keeps key spend separate from nullable allowance and account credits', () => {
    const { meters } = parseOpenRouterKeyUsage({ data: { usage_daily: 1, usage_weekly: 2, usage_monthly: 3, usage: 4, limit: null, limit_remaining: null } });
    expect(meters.map(m => [m.meterId, m.used, m.limit, m.unit])).toEqual([
      ['key-spend-daily', 1, null, 'usd'], ['key-spend-weekly', 2, null, 'usd'],
      ['key-spend-monthly', 3, null, 'usd'], ['key-spend-lifetime', 4, null, 'usd'],
      ['key-allowance', null, null, 'usd'],
    ]);
    expect(meters.every(m => m.limitScope === undefined && m.utilizationPct === null)).toBe(true);
    expect(meters.every(m => m.currency === 'USD')).toBe(true);
    expect(parseOpenRouterKeyUsage({ data: { usage: 100, limit: 10, limit_remaining: 7 } }).meters.at(-1))
      .toMatchObject({ used: 3, limit: 10, remaining: 7, utilizationPct: null });
    expect(parseOpenRouterCredits({ data: { total_credits: 10, total_usage: 12 } }).meters)
      .toMatchObject([{ meterId: 'account-credits', remaining: -2, unit: 'usd', currency: 'USD', limitScope: 'account',
        limit: null, utilizationPct: null }]);
  });
  it('refuses malformed money rather than presenting zero or a fabricated cap', () => {
    expect(() => parseOpenRouterKeyUsage({ data: { usage: '3' } })).toThrow();
    expect(() => parseOpenRouterCredits({ data: { total_credits: null, total_usage: 2 } })).toThrow();
  });
});
