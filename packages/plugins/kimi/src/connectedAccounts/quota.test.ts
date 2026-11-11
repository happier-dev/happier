import { describe, expect, it } from 'vitest';
import { fetchKimiQuota, parseKimiQuota } from './quota.js';

describe('Kimi sourced usage', () => {
  it('preserves every returned window, reset, and separate money unit', () => {
    const quota = parseKimiQuota({ usages: {
      limit_5h: { used_ratio: '0.25', reset_time: '2026-11-09T15:00:00Z' },
      limit_7d: { used_ratio: 0.5 }, limit_month_total: { used_ratio: 0.6 }, limit_month_code: { used_ratio: 0.7 },
    }, boosterWallet: { balance: { type: 'BOOSTER', amount: '100000000', amountLeft: '25000000' }, monthlyUsed: { priceInCents: '12', currency: 'USD' } } }, 123);
    expect(quota.observedAtMs).toBe(123);
    expect(quota.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'limit_5h', utilizationPct: 25, resetsAtMs: Date.parse('2026-11-09T15:00:00Z') }),
      expect.objectContaining({ id: 'limit_7d', utilizationPct: 50 }),
      expect.objectContaining({ id: 'limit_month_total', utilizationPct: 60 }),
      expect.objectContaining({ id: 'limit_month_code', utilizationPct: 70 }),
      expect.objectContaining({ id: 'booster_balance', remaining: 0.25, limit: 1, unit: 'usd' }),
      expect.objectContaining({ id: 'monthly_spend', used: 0.12, unit: 'usd' }),
    ]));
  });
  it('does not manufacture zero allowance from an unsupported response', () => {
    expect(() => parseKimiQuota({}, 123)).toThrowError(expect.objectContaining({ quotaFetchErrorCode: 'malformed' }));
  });
  it('preserves a sourced monthly extra-usage cap without inventing a currency or disabled cap', () => {
    const wallet = { monthlyUsed: { priceInCents: '12', currency: 'CNY' }, monthlyChargeLimit: { priceInCents: '100', currency: 'CNY' }, monthlyChargeLimitEnabled: true };
    expect(parseKimiQuota({ boosterWallet: wallet }, 123).limits).toContainEqual(expect.objectContaining({ id: 'monthly_spend', used: 12, limit: 100, unit: 'unknown', details: { note: expect.stringContaining('CNY cents') } }));
    expect(parseKimiQuota({ boosterWallet: { ...wallet, monthlyChargeLimitEnabled: false } }, 123).limits).toContainEqual(expect.objectContaining({ id: 'monthly_spend', used: 12, unit: 'unknown' }));
    expect(parseKimiQuota({ boosterWallet: { ...wallet, monthlyChargeLimitEnabled: false } }, 123).limits[0]).not.toHaveProperty('limit');
  });
  it('keeps different-currency caps and fixed-point balances in their declared denomination', () => {
    const quota = parseKimiQuota({ boosterWallet: {
      monthlyUsed: { priceInCents: 12, currency: 'USD' },
      monthlyChargeLimit: { priceInCents: 100, currency: 'CNY' }, monthlyChargeLimitEnabled: true,
      balance: { type: 'BOOSTER', amount: 100000000, amountLeft: 25000000 },
    } }, 123);
    expect(quota.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'monthly_spend', used: 0.12, unit: 'usd' }),
      expect.objectContaining({ id: 'monthly_charge_limit', limit: 100, unit: 'unknown', details: { note: expect.stringContaining('CNY cents') } }),
      expect.objectContaining({ id: 'booster_balance', remaining: 25, limit: 100, unit: 'unknown', details: { note: expect.stringContaining('CNY cents') } }),
    ]));
    expect(quota.limits.find(limit => limit.id === 'monthly_spend')).not.toHaveProperty('limit');
    expect(parseKimiQuota({ boosterWallet: { monthlyChargeLimit: { priceInCents: 125, currency: 'USD' }, monthlyChargeLimitEnabled: true } }, 123).limits)
      .toContainEqual(expect.objectContaining({ id: 'monthly_charge_limit', limit: 1.25, unit: 'usd' }));
  });
  it('retains nonterminal policy HTTP provenance in a demanded quota failure', async () => {
    await expect(fetchKimiQuota({ http: { async request() { return { status: 403, headers: {}, body: new Uint8Array(), finalUrl: 'https://api.kimi.ai/coding/v1/usages' }; } }, baseUrl: 'https://api.kimi.ai/coding/v1', headers: {}, observedAtMs: 123, signal: new AbortController().signal }))
      .rejects.toMatchObject({ status: 403, quotaFetchErrorCode: 'network' });
  });
});
