import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from './providerAccountUsagePrimitives.js';
import { sealProviderAccountUsageSnapshot } from './accountUsage.js';
import { openProviderAccountUsageRecordV4, projectProviderAccountUsageQuotaReadV1 } from './providerAccountUsageHistory.js';

describe('opened accepted provider history', () => {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 100, fetchedAtMs: 100, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', meters: [], subscription: { status: 'subscribed', renewal: 'off', observedAtMs: 100, staleAfterMs: 1000, currentPeriodEndAtMs: 200 } });
  const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
  const metadata = { fetchedAt: 100, staleAfterMs: 1000, status: 'ok' as const };
  it('composes only the admitted user price and never trusts a provider-supplied entered amount', () => {
    const price = { amount: 17, currency: 'EUR', enteredAtMs: 100 };
    const record = { content: { t: 'plain' as const, v: { ...snapshot,
      subscription: { ...snapshot.subscription, enteredMonthlyPrice: { ...price, amount: 999 } } } }, metadata, sources: [] };
    expect(openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain', record }).subscription?.enteredMonthlyPrice).toBeUndefined();
    expect(openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain', record, enteredMonthlyPrice: price }).subscription?.enteredMonthlyPrice).toEqual(price);
  });
  it('projects a current-only quota read with its configured advisory targets', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    expect(projectProviderAccountUsageQuotaReadV1({ input: { source }, current: snapshot, nowMs: 100, targets: [{ id: 'personal', scope: { kind: 'personal' }, utilizationFraction: .8 }] })).toMatchObject({ current: snapshot, targets: [{ id: 'personal' }] });
  });
  it('projects ended unused amounts only in a witnessed denomination, with terminal and estimated history distinct', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const sample = (at: number, used: number) => ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot,
      state: 'loaded_data', observedAtMs: at, fetchedAtMs: at, subscription: undefined,
      meters: [{ meterId: 'week', label: 'Weekly', used, limit: 100, remaining: 100 - used,
        unit: 'requests', utilizationPct: used, resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
    const read = (samples: ReturnType<typeof sample>[]) => projectProviderAccountUsageQuotaReadV1({ input: { source },
      current: null, nowMs: 1500, history: { entries: samples.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null } });
    expect(read([sample(500, 20), sample(1000, 40)])).toMatchObject({ unusedCapacity: { historyStatus: 'returned_page',
      windows: [{ value: { status: 'available', unusedAmount: 60, unusedFraction: .6, unit: 'requests',
        method: 'terminal_observation', qualification: 'confirmed', observedAtMs: 1000, sampleCount: 2 } }] } });
    expect(read([sample(250, 10), sample(500, 20)])).toMatchObject({ unusedCapacity: {
      windows: [{ value: { status: 'available', unusedAmount: 60, method: 'linear_pace_at_last_observation', qualification: 'estimated' } }] } });
    const changed = sample(1000, 40); changed.meters[0]!.limit = 200;
    expect(read([sample(500, 20), changed])).toMatchObject({ unusedCapacity: { windows: [{ value: { status: 'insufficient_basis', reason: 'denominator_changed' } }] } });
    const percentOnly = sample(1000, 40); Object.assign(percentOnly.meters[0]!, { used: null, remaining: null, limit: null, utilizationPct: 40 });
    expect(read([percentOnly])).toMatchObject({ unusedCapacity: { windows: [{ value: { status: 'insufficient_basis', reason: 'unknown_denominator' } }] } });
    expect(projectProviderAccountUsageQuotaReadV1({ input: { source }, current: snapshot, nowMs: 1500 })).toMatchObject({ unusedCapacity: { historyStatus: 'not_loaded', windows: [] } });
  });
  it('opens keyless plain history and preserves protected subscription through the canonical sealed opener', () => {
    const priced = ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot, subscription: { ...snapshot.subscription,
      currentPeriodStartAtMs: 0, monetaryFacts: [
        { kind: 'paid', amount: 16, currency: 'USD', period: { startAtMs: 0, endAtMs: 200 }, source: { kind: 'provider', id: 'test-receipt', version: 'v1' }, effectiveAtMs: 0, asOfMs: 100 },
        { kind: 'list', amount: 20, currency: 'USD', period: { startAtMs: 0, endAtMs: 200 }, source: { kind: 'published', id: 'https://example.test/pricing', version: 'test-vector-v1' }, effectiveAtMs: 0, asOfMs: 100 },
      ] } });
    expect(openProviderAccountUsageRecordV4({ recordId: priced.recordId, accountMode: 'plain', record: { content: { t: 'plain', v: priced }, metadata, sources: [] } })).toEqual(priced);
    const sealed = sealProviderAccountUsageSnapshot({ snapshot: priced, material, randomBytes: length => new Uint8Array(length).fill(2) });
    expect(openProviderAccountUsageRecordV4({ recordId: priced.recordId, accountMode: 'e2ee', material, record: { content: { t: 'encrypted', c: sealed.ciphertext, subscription: sealed.subscription }, metadata, sources: [] } })).toEqual(priced);
  });
  it('refuses mode mismatch, wrong-key and tampered subscription rather than returning empty history', () => {
    const plain = { content: { t: 'plain' as const, v: snapshot }, metadata, sources: [] };
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'e2ee', material, record: plain })).toThrow();
    const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(2) });
    const record = { content: { t: 'encrypted' as const, c: sealed.ciphertext, subscription: sealed.subscription }, metadata, sources: [] };
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain', record })).toThrow();
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) }, record })).toThrow();
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'e2ee', material, record: { ...record, content: { ...record.content, subscription: { ...sealed.subscription!, observedAtMs: 101 } } } })).toThrow();
  });
});
