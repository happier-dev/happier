import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { buildProviderAccountUsageDaySummaryV1, deriveProviderAccountUsageDayQuotaHistoryV1, openProviderAccountUsageDaySummaryV1, sealProviderAccountUsageDaySummaryV1 } from './providerAccountUsageDaySummary.js';
import { projectProviderAccountUsageQuotaReadV1 } from './providerAccountUsageHistory.js';

const day = 86_400_000;
const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
const recordId = buildProviderAccountUsageRecordId(recordKey);
function sample(at: number, used: number, resetAtMs: number): ProviderAccountUsageSnapshotV1 {
  return { v: 1, recordId, recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' },
    observedAtMs: at, fetchedAtMs: at, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
    meters: [{ meterId: 'hour', label: 'Hourly', used, limit: 100, remaining: 100 - used, utilizationPct: used,
      resetsAt: resetAtMs, windowDurationMs: 1000, unit: 'requests', status: 'ok', details: {} }] };
}
describe('provider quota daily summary', () => {
  it('uses the accepted history clock when provider timestamps move backwards', () => {
    const first = { ...sample(day + 100, 20, day + 1000), observedAtMs: day + 800 };
    const last = { ...sample(day + 900, 60, day + 1000), observedAtMs: day + 200 };
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [last, first] });
    expect(summary.lastSnapshot).toEqual(last);
    expect(summary.windows[0]).toMatchObject({ firstObservedAtMs: day + 100, lastObservedAtMs: day + 900, lastSnapshot: last });
  });
  it('keeps ended-window chart values when old detail is replaced by daily summaries', () => {
    const snapshots = [sample(day + 100, 20, day + 1000), sample(day + 1000, 85, day + 1000),
      sample(day + 1100, 5, day + 2000), sample(day + 2000, 30, day + 2000), sample(day + 2100, 2, day + 3000)];
    const input = { input: { source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const } }, current: snapshots[4]!, nowMs: day + 2100 };
    const full = projectProviderAccountUsageQuotaReadV1({ ...input, history: { entries: snapshots.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null } });
    const retained = projectProviderAccountUsageQuotaReadV1({ ...input, history: { entries: [], nextCursor: null },
      daySummaries: [buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots })] });
    const values = (result: typeof full) => result.unusedCapacity?.windows.map(({ window, value }) => ({ window,
      value: value.status === 'available' ? { unusedAmount: value.unusedAmount, unusedFraction: value.unusedFraction, observedAtMs: value.observedAtMs } : value }));
    expect(values(full)).toHaveLength(2);
    expect(values(retained)).toEqual(values(full));
  });
  it('keeps exact pace and unused facts within the selected intraday range', () => {
    const snapshots = [sample(day + 100, 20, day + 1000), sample(day + 1000, 85, day + 1000), sample(day + 1100, 5, day + 2000)];
    const input = { source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const },
      history: { range: { startAtMs: day + 1100, endAtMs: day + 1200 }, pageSize: 100 } };
    const history = { entries: [{ id: 'selected', observedAtMs: day + 1100, snapshot: snapshots[2]! }], nextCursor: null };
    const full = projectProviderAccountUsageQuotaReadV1({ input, current: snapshots[2]!, history, nowMs: day + 1100, daySummaries: [] });
    const retained = projectProviderAccountUsageQuotaReadV1({ input, current: snapshots[2]!, history, nowMs: day + 1100,
      daySummaries: [buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots })] });
    expect(retained.unusedCapacity).toEqual(full.unusedCapacity);
    expect(retained.pace).toEqual(full.pace);
    expect(retained.pageFacts?.witnessedResets).toEqual(full.pageFacts?.witnessedResets);
    expect(retained.pageFacts?.dayQuotaHistory).toHaveLength(1);
  });
  it('preserves observed reset aggregate counts without inventing an exact reset witness', () => {
    const snapshots = [sample(day + 100, 20, day + 1000), sample(day + 900, 85, day + 1000),
      sample(day + 1100, 5, day + 2000), sample(day + 1900, 30, day + 2000), sample(day + 2100, 2, day + 3000)];
    const input = { source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const },
      projection: { range: { startAtMs: day, endAtMs: 2 * day }, resolution: 'accepted_observations' as const } };
    const full = projectProviderAccountUsageQuotaReadV1({ input, current: snapshots.at(-1)!, nowMs: day + 2100,
      history: { entries: snapshots.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null }, daySummaries: [] });
    const retained = projectProviderAccountUsageQuotaReadV1({ input, current: snapshots.at(-1)!, nowMs: day + 2100,
      history: { entries: [], nextCursor: null }, daySummaries: [buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots })] });
    expect(full.pageFacts?.witnessedResets).toHaveLength(2);
    expect(retained.pageFacts?.witnessedResets).toEqual(full.pageFacts?.witnessedResets);
    expect(retained.pageFacts?.resetWitness).toBeNull();
  });
  it('preserves separate quota windows, peaks and every witnessed intraday reset instead of adding counters', () => {
    const snapshots = [sample(day + 100, 20, day + 1000), sample(day + 900, 85, day + 1000),
      sample(day + 1100, 5, day + 2000), sample(day + 1900, 30, day + 2000), sample(day + 2100, 2, day + 3000)];
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots });
    expect(summary.lastSnapshot).toEqual(snapshots[4]);
    expect(summary.windows.map(window => [window.peakUsed, window.firstObservedAtMs, window.lastObservedAtMs]))
      .toEqual([[85, day + 100, day + 900], [30, day + 1100, day + 1900], [2, day + 2100, day + 2100]]);
    expect(summary.windows.flatMap(window => window.resets)).toEqual([
      { resetAtMs: day + 1000, usedBeforeReset: 85 }, { resetAtMs: day + 2000, usedBeforeReset: 30 }]);
  });
  it('retains a midnight reset and its pre-reset used value from the preceding day', () => {
    const before = sample(day - 100, 80, day);
    const current = sample(day + 100, 5, day + 1000);
    const full = deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots: [before, current] });
    const retained = deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots: [], summaries: full });
    expect(full[1]?.windows.flatMap(window => window.resets)).toEqual([{ resetAtMs: day, usedBeforeReset: 80 }]);
    expect(retained).toEqual(full);
  });
  it('merges backdated observations without replacing a later last snapshot or losing retained reset evidence', () => {
    const previous = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day,
      snapshots: [sample(day + 100, 50, day + 1000), sample(day + 1100, 3, day + 2000)] });
    const merged = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, previous,
      snapshots: [sample(day + 200, 80, day + 1000)] });
    expect(merged.lastSnapshot.observedAtMs).toBe(day + 1100);
    expect(merged.windows[0]?.peakUsed).toBe(80);
    expect(merged.windows.flatMap(window => window.resets)).toEqual([{ resetAtMs: day + 1000, usedBeforeReset: 80 }]);
  });
  it('keeps day chart facts identical on 30D/90D/1Y/All ranges across the detail boundary', () => {
    const snapshots = Array.from({ length: 120 }, (_, index) => [sample((index + 1) * day + 100, 40, (index + 1) * day + 1000),
      sample((index + 1) * day + 900, 85, (index + 1) * day + 1000), sample((index + 1) * day + 1100, 3, (index + 1) * day + 2000)]).flat();
    const summaries = deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots: snapshots.filter(snapshot => snapshot.fetchedAtMs < 31 * day) });
    for (const rangeDays of [30, 90, 365, Infinity]) {
      const from = Math.max(0, (121 - rangeDays) * day);
      const within = (snapshot: ProviderAccountUsageSnapshotV1) => snapshot.fetchedAtMs >= from;
      expect(deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots: snapshots.filter(snapshot => snapshot.fetchedAtMs >= 31 * day && within(snapshot)),
        summaries: summaries.filter(summary => summary.dayStartAtMs >= from) }))
        .toEqual(deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots: snapshots.filter(within) }));
    }
  });
  it.each(['plain', 'e2ee'] as const)('round trips %s summaries and rejects mode or record substitutions', accountMode => {
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [sample(day + 100, 20, day + 1000)] });
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const content = accountMode === 'plain' ? { t: 'plain' as const, v: summary }
      : sealProviderAccountUsageDaySummaryV1({ summary, material, randomBytes: n => new Uint8Array(n).fill(3) });
    expect(openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, accountMode, material, content })).toEqual(summary);
    expect(() => openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, accountMode, material, content })).toThrow();
    expect(() => openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, accountMode: accountMode === 'plain' ? 'e2ee' : 'plain', material, content })).toThrow();
  });
});
