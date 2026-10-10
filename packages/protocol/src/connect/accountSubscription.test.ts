import { describe, expect, it } from 'vitest';
import { ProviderAccountSubscriptionV1Schema, mergeProviderAccountSubscription, projectProviderAccountSubscriptionMonetaryFacts } from './accountSubscription.js';

describe('ProviderAccountSubscriptionV1', () => {
  it('keeps a user monthly amount distinct from payments/list prices and qualifies it only with a witnessed current period', () => {
    const price = { amount: 17, currency: 'EUR', enteredAtMs: 1550 };
    const parsed = ProviderAccountSubscriptionV1Schema.safeParse({ status: 'subscribed', renewal: 'on', observedAtMs: 1500,
      staleAfterMs: 1000, currentPeriodStartAtMs: 1000, currentPeriodEndAtMs: 2000, enteredMonthlyPrice: price });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription: parsed.data, nowMs: 1600 })).toMatchObject({
      paid: null, list: null, entered: { kind: 'entered', amount: 17, currency: 'EUR', source: { kind: 'user' },
        period: { startAtMs: 1000, endAtMs: 2000 }, effectiveAtMs: 1550 },
    });
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription: parsed.data, nowMs: 1500 })).toMatchObject({ entered: null });
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription: { ...parsed.data, currentPeriodStartAtMs: undefined }, nowMs: 1600 })).toMatchObject({ entered: null });
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription: parsed.data, nowMs: 2100 })).toMatchObject({ entered: null });
  });
  it('selects only observed effective monetary facts for the actual current subscription period and matching tier/region', () => {
    const fact = { kind: 'paid' as const, amount: 16, currency: 'USD', period: { startAtMs: 1000, endAtMs: 2000 }, source: { kind: 'provider' as const, id: 'receipt', version: 'v1' }, effectiveAtMs: 1000, asOfMs: 1500 };
    const list = { ...fact, kind: 'list' as const, amount: 20, source: { kind: 'published' as const, id: 'https://example.test/pricing', version: '2026-10-09' }, tier: 'pro', region: 'US' };
    const subscription = ProviderAccountSubscriptionV1Schema.parse({ status: 'subscribed', renewal: 'on', observedAtMs: 1500, staleAfterMs: 1000,
      currentPeriodStartAtMs: 1000, currentPeriodEndAtMs: 2000, monetaryFacts: [
        { ...fact, amount: 100, period: { startAtMs: 0, endAtMs: 1000 } }, fact,
        { ...fact, amount: 200, period: { startAtMs: 2000, endAtMs: 3000 }, effectiveAtMs: 2000 }, list,
        { ...list, amount: 30, effectiveAtMs: 1700 }, { ...list, amount: 40, asOfMs: 1700 }, { ...list, amount: 50, region: 'UK' },
      ] });
    const project = (value = subscription) => projectProviderAccountSubscriptionMonetaryFacts({ subscription: value, nowMs: 1600, tier: 'pro', region: 'US' });
    expect(project()).toEqual({ paid: fact, list, entered: null });
    expect(project({ ...subscription, currentPeriodStartAtMs: undefined })).toEqual({ paid: null, list: null, entered: null });
    expect(project({ ...subscription, currentPeriodStartAtMs: 0, currentPeriodEndAtMs: 1000 })).toEqual({ paid: null, list: null, entered: null });
    expect(project({ ...subscription, staleAfterMs: 100 })).toEqual({ paid: null, list: null, entered: null });
    expect(project({ ...subscription, observedAtMs: 1700 })).toEqual({ paid: null, list: null, entered: null });
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription: { ...subscription, monetaryFacts: [list] }, nowMs: 1600 })).toEqual({ paid: null, list: null, entered: null });
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription, nowMs: 2500, tier: 'pro', region: 'US' })).toEqual({ paid: null, list: null, entered: null });
  });
  it('does not treat a published list page as evidence of an actual Account payment', () => {
    const value = { status: 'subscribed', renewal: 'on', observedAtMs: 2000, staleAfterMs: 1000, monetaryFacts: [{ kind: 'paid', amount: 20, currency: 'USD', period: { startAtMs: 0, endAtMs: 2000 }, source: { kind: 'published', id: 'https://example.test/pricing', version: '1' }, effectiveAtMs: 0, asOfMs: 2000 }] };
    expect(ProviderAccountSubscriptionV1Schema.safeParse(value).success).toBe(false);
  });
  it('preserves separately attributed actual paid and dated list facts without treating one as the other', () => {
    const subscription = {
      status: 'subscribed', renewal: 'on', observedAtMs: 2000, staleAfterMs: 60000,
      monetaryFacts: [
        { kind: 'paid', amount: 16, currency: 'USD', period: { startAtMs: 0, endAtMs: 2000 }, source: { kind: 'provider', id: 'receipt-1', version: 'v1' }, effectiveAtMs: 0, asOfMs: 2000 },
        { kind: 'list', amount: 20, currency: 'USD', period: { startAtMs: 0, endAtMs: 2000 }, source: { kind: 'published', id: 'https://example.test/pricing', version: '2026-10-09' }, effectiveAtMs: 0, asOfMs: 2000, tier: 'pro', region: 'US' },
      ],
    };
    expect(ProviderAccountSubscriptionV1Schema.parse(subscription)).toEqual(subscription);
    expect(mergeProviderAccountSubscription(ProviderAccountSubscriptionV1Schema.parse(subscription), undefined)?.monetaryFacts).toEqual(subscription.monetaryFacts);
  });
  it('keeps newer successful observations independent from older failures', () => {
    const previous = ProviderAccountSubscriptionV1Schema.parse({
      status: 'subscribed', renewal: 'on', observedAtMs: 2_000, staleAfterMs: 60_000,
    });
    const incoming = ProviderAccountSubscriptionV1Schema.parse({
      status: 'unavailable', renewal: 'unknown', observedAtMs: 1_000, staleAfterMs: 60_000,
      lastRefreshError: { observedAtMs: 3_000, code: 'network' },
    });
    expect(mergeProviderAccountSubscription(previous, incoming)).toEqual({
      ...previous, lastRefreshError: incoming.lastRefreshError,
    });
  });
  it('retains historical monetary observations when a successful subscription refresh has no price observation', () => {
    const fact = { kind: 'paid' as const, amount: 16, currency: 'USD', period: { startAtMs: 0, endAtMs: 1000 }, source: { kind: 'provider' as const, id: 'receipt', version: 'v1' }, effectiveAtMs: 0, asOfMs: 500 };
    const previous = ProviderAccountSubscriptionV1Schema.parse({ status: 'subscribed', renewal: 'on', observedAtMs: 500, staleAfterMs: 1000, currentPeriodStartAtMs: 0, currentPeriodEndAtMs: 1000, monetaryFacts: [fact] });
    const incoming = ProviderAccountSubscriptionV1Schema.parse({ ...previous, observedAtMs: 1500, currentPeriodStartAtMs: 1000, currentPeriodEndAtMs: 2000, monetaryFacts: undefined });
    const merged = mergeProviderAccountSubscription(previous, incoming);
    expect(merged).toEqual({ ...incoming, monetaryFacts: [fact] });
    expect(projectProviderAccountSubscriptionMonetaryFacts({ subscription: merged, nowMs: 1500 })).toEqual({ paid: null, list: null, entered: null });
  });
});
