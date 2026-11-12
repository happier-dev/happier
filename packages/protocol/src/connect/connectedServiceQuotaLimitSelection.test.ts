import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaMeterV1 } from './connectedServiceSchemas.js';
import {
  hasConnectedServiceQuotaCreditHeadroom,
  resolveConnectedServiceQuotaMeterLimitIdentity,
  selectConnectedServiceQuotaMetersForLimitSelection,
  summarizeConnectedServiceQuotaCredits,
} from './connectedServiceQuotaLimitSelection.js';

const meters = [
  { meterId: 'standard:primary', providerLimitId: 'standard' },
  { meterId: 'spark:primary', providerLimitId: 'spark' },
  { meterId: 'weekly' },
] as ConnectedServiceQuotaMeterV1[];

describe('selectConnectedServiceQuotaMetersForLimitSelection', () => {
  it('uses the provider identity when present and the legacy meter identity otherwise', () => {
    expect(resolveConnectedServiceQuotaMeterLimitIdentity(meters[0]!)).toBe('standard');
    expect(resolveConnectedServiceQuotaMeterLimitIdentity(meters[2]!)).toBe('weekly');
  });

  it('keeps every meter for the default/all selection', () => {
    expect(selectConnectedServiceQuotaMetersForLimitSelection(meters)).toBe(meters);
    expect(selectConnectedServiceQuotaMetersForLimitSelection(meters, {
      mode: 'all',
      providerLimitIds: [],
    })).toBe(meters);
  });

  it('uses provider allowance identity and keeps the meterId compatibility fallback', () => {
    expect(selectConnectedServiceQuotaMetersForLimitSelection(meters, {
      mode: 'selected',
      providerLimitIds: ['spark', 'weekly'],
    })).toEqual([meters[1], meters[2]]);
  });
});

function creditMeter(overrides: Partial<ConnectedServiceQuotaMeterV1> = {}): ConnectedServiceQuotaMeterV1 {
  return {
    meterId: 'credits', label: 'Credits', used: null, limit: null, unit: 'credits',
    utilizationPct: null, resetsAt: null, status: 'ok', details: {}, ...overrides,
  };
}

describe('provider credit meters', () => {
  it('keeps account credits under every allowance selection', () => {
    const credits = creditMeter();
    expect(selectConnectedServiceQuotaMetersForLimitSelection([...meters, credits], {
      mode: 'selected',
      providerLimitIds: ['spark'],
    })).toEqual([meters[1], credits]);
  });

  it('reads headroom from the provider verdict, a capped spend share, or a balance', () => {
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ remaining: 16845, isExhausted: false }))).toBe(true);
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ remaining: 16845, isExhausted: true }))).toBe(false);
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ remaining: 0 }))).toBe(false);
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ isExhausted: false }))).toBe(true);
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ utilizationPct: 40 }))).toBe(true);
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ utilizationPct: 100 }))).toBe(false);
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ utilizationPct: 10, status: 'unavailable' }))).toBe(false);
    expect(hasConnectedServiceQuotaCreditHeadroom({ ...creditMeter({ remaining: 5 }), unit: 'unknown' })).toBe(false);
    // An adapter-categorized allowance stays an allowance whatever its unit.
    expect(hasConnectedServiceQuotaCreditHeadroom(creditMeter({ remaining: 5, details: { limitCategory: 'usage_limit' } }))).toBe(false);
  });

  it('summarizes credits only for accounts that report them', () => {
    expect(summarizeConnectedServiceQuotaCredits([...meters])).toBeNull();
    expect(summarizeConnectedServiceQuotaCredits([...meters, creditMeter({ remaining: 16845, isExhausted: false })]))
      .toEqual({ available: true, balance: 16845 });
  });
});
