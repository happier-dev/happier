import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { buildProviderAccountUsageDaySummaryV1, deriveProviderAccountUsageDayQuotaHistoryV1, openProviderAccountUsageDaySummaryV1, sealProviderAccountUsageDaySummaryV1, packProviderAccountUsageDaySummaryV1 } from './providerAccountUsageDaySummary.js';
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
  it('summarizes every witnessed day of flat weekly usage across a reset without filling gaps', () => {
    const weekly = (observedDay: number, resetDay: number) => {
      const snapshot = sample(observedDay * day, 20, resetDay * day);
      snapshot.meters[0] = { ...snapshot.meters[0]!, meterId: 'weekly', label: 'Weekly', windowDurationMs: 7 * day };
      return ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
    };
    const first = weekly(1, 7);
    const middle = weekly(3, 7);
    const latest = weekly(6, 7);
    const nextFirst = weekly(8, 14);
    const nextMiddle = weekly(10, 14);
    const nextLatest = weekly(13, 14);
    const rows = (snapshots: readonly ProviderAccountUsageSnapshotV1[]) =>
      deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots }).flatMap(summary =>
        summary.windows.map(window => ({ dayStartAtMs: summary.dayStartAtMs, observedAtMs: summary.lastSnapshot.observedAtMs,
          lastObservedAtMs: window.lastObservedAtMs, resetAtMs: window.resetAtMs, peakUsed: window.peakUsed,
          resets: window.resets })));
    const day1 = { dayStartAtMs: day, observedAtMs: day, lastObservedAtMs: day, resetAtMs: 7 * day, peakUsed: 20, resets: [] };
    const day3 = { ...day1, dayStartAtMs: 3 * day, observedAtMs: 3 * day, lastObservedAtMs: 3 * day };
    const day6 = { ...day1, dayStartAtMs: 6 * day, observedAtMs: 6 * day, lastObservedAtMs: 6 * day };
    const day8 = { dayStartAtMs: 8 * day, observedAtMs: 8 * day, lastObservedAtMs: 8 * day, resetAtMs: 14 * day,
      peakUsed: 20, resets: [{ resetAtMs: 7 * day, usedBeforeReset: 20 }] };
    const day10 = { ...day8, dayStartAtMs: 10 * day, observedAtMs: 10 * day, lastObservedAtMs: 10 * day, resets: [] };
    const day13 = { ...day8, dayStartAtMs: 13 * day, observedAtMs: 13 * day, lastObservedAtMs: 13 * day, resets: [] };
    expect(rows([first, middle, latest, nextFirst, nextMiddle, nextLatest])).toEqual([day1, day3, day6, day8, day10, day13]);
    expect(rows([first, latest, nextFirst, nextMiddle, nextLatest])).toEqual([day1, day6, day8, day10, day13]);
    expect(rows([first, middle, nextFirst, nextMiddle, nextLatest])).toEqual([day1, day3, day8, day10, day13]);
  });
  it('losslessly encodes the Claude 13-day shape within its distinct-fact budget despite reset-clock revisions', () => {
    // Loaded census: 4,211 seven_day entries / 2,486 exact clocks. Each
    // revision remains distinct; neither second rounding nor a window cap is valid.
    const snapshots = Array.from({ length: 4211 }, (_, index) => {
      const at = day * (1 + Math.floor(index / 324)) + (index % 324 + 1) * 100;
      const clock = index % 2486;
      const reset = 10 * day + Math.floor(clock / 829) * 7 * day + clock % 829;
      const value = sample(at, 50, reset);
      value.meters[0] = { ...value.meters[0]!, meterId: 'seven_day', label: 'Weekly', windowDurationMs: 7 * day };
      value.diagnostics = [{ kind: 'provider_http', status: 200, observedAtMs: at }];
      return value;
    });
    const summaries = deriveProviderAccountUsageDayQuotaHistoryV1({ recordId, snapshots });
    expect(summaries).toHaveLength(13);
    const identityKeys = summaries.flatMap(summary => summary.windows.map(window => JSON.stringify([window.meterId,
      Math.round((window.resetAtMs ?? 0) / 1000), window.resetAtMs === null || window.windowStartAtMs === null ? null
        : window.resetAtMs - window.windowStartAtMs])));
    expect(new Set(identityKeys)).toHaveLength(6);
    expect(summaries.flatMap(summary => summary.windows).some(window => (window.resetAtMs ?? 0) % 1000 !== 0)).toBe(true);
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    // Budget from distinct facts, independent of encoding: each distinct meter,
    // each exact clock pair/diagnostic, each window's scalar facts, daily context.
    const distinctMeters = new Set(snapshots.map(value => JSON.stringify(value.meters[0])));
    const budget = [...distinctMeters].reduce((bytes, value) => bytes + size(JSON.parse(value)), 0)
      + snapshots.reduce((bytes, value, index) => bytes + size([String(index), value.fetchedAtMs, value.observedAtMs]) + size(value.diagnostics), 0)
      + summaries.reduce((bytes, summary) => bytes + size(summary.lastSnapshot)
        + summary.windows.reduce((total, window) => total + size([window.meterId, window.windowStartAtMs, window.resetAtMs,
          window.peakUsed, window.firstObservedAtMs, window.lastObservedAtMs, window.resets]), 0), 0);
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const contents = summaries.map(summary => sealProviderAccountUsageDaySummaryV1({ summary, material, randomBytes: n => new Uint8Array(n).fill(3) }));
    contents.forEach((content, index) => expect(openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: summaries[index]!.dayStartAtMs,
      accountMode: 'e2ee', material, content })).toEqual(summaries[index]));
    const encodedBytes = contents.reduce((bytes, content) => bytes + size(content), 0);
    const materializedWindows = summaries.reduce((count, summary) => count + summary.windows.length, 0);
    const distinctWindowIdentities = new Set(identityKeys).size;
    console.info(JSON.stringify({ fixture: 'claude-reset-revisions', days: summaries.length, rawObservations: 4211,
      materializedWindows, distinctWindowIdentities, distinctClocks: 2486,
      decodedBytes: size(summaries), encodedBytes, distinctFactBudget: budget }));
    expect(encodedBytes).toBeLessThanOrEqual(Math.ceil(budget * 4 / 3) + summaries.length * 128);
  });
  it('uses the accepted history clock when provider timestamps move backwards', () => {
    const first = { ...sample(day + 100, 20, day + 1000), observedAtMs: day + 800 };
    const last = { ...sample(day + 900, 60, day + 1000), observedAtMs: day + 200 };
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [last, first] });
    expect(summary.lastSnapshot).toEqual(last);
    expect(summary.windows[0]).toMatchObject({ firstObservedAtMs: day + 100, lastObservedAtMs: day + 900, lastSnapshot: last });
    expect(summary).toMatchObject({ observedAtRange: { startAtMs: day + 200, endAtMs: day + 801 } });
    const late = { ...sample(day + 50, 10, day + 1000), observedAtMs: day + 900 };
    const merged = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [late], previous: summary });
    expect(merged).toMatchObject({ lastSnapshot: last, observedAtRange: { startAtMs: day + 200, endAtMs: day + 901 } });
    const backfill = { ...late, observedAtMs: day + 500 };
    const rewritten = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [backfill],
      previous: summary, completeDayHistory: true });
    expect(rewritten.observedAtRange).toEqual(summary.observedAtRange);
    const { observedAtRange: _bounds, ...legacy } = merged;
    const unproven = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [late], previous: legacy });
    expect(unproven.observedAtRange).toBeUndefined();
    const rebuilt = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [], previous: legacy, completeDayHistory: true });
    expect(rebuilt).toMatchObject({ observedAtRange: { startAtMs: day + 200, endAtMs: day + 201 },
      windows: [{ peakUsed: 60, firstObservedAtMs: day + 50, lastObservedAtMs: day + 900 }] });
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
  it('preserves legacy same-second peaks, bounds and resets when no original detail remains', () => {
    const earlier = sample(day + 1200, 20, day + 2000);
    const latest = sample(day + 1800, 30, day + 2400);
    const first = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [earlier] });
    const second = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [latest] });
    const previous = { ...second, windows: [
      { ...first.windows[0]!, peakUsed: 90, firstObservedAtMs: day + 1000, resets: [
        { resetAtMs: day + 1000, usedBeforeReset: 85 }, { resetAtMs: day + 2000, usedBeforeReset: 20 },
      ] },
      { ...second.windows[0]!, resets: [{ resetAtMs: day + 2400, usedBeforeReset: 30 }] },
    ] };
    const rebuilt = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, previous, snapshots: [] });
    expect(rebuilt.windows).toEqual([{ ...second.windows[0]!, peakUsed: 90,
      firstObservedAtMs: day + 1000, lastObservedAtMs: day + 1800, resets: [
        { resetAtMs: day + 1000, usedBeforeReset: 85 }, { resetAtMs: day + 2400, usedBeforeReset: 30 },
      ] }]);
    expect(previous.windows[0]?.peakUsed).toBe(90);
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
    const content = accountMode === 'plain' ? { t: 'plain' as const, v: packProviderAccountUsageDaySummaryV1(summary) }
      : sealProviderAccountUsageDaySummaryV1({ summary, material, randomBytes: n => new Uint8Array(n).fill(3) });
    expect(openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, accountMode, material, content })).toEqual(summary);
    expect(() => openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: 0, accountMode, material, content })).toThrow();
    expect(() => openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, accountMode: accountMode === 'plain' ? 'e2ee' : 'plain', material, content })).toThrow();
  });
  it('rejects compact references that have no corresponding snapshot or diagnostic', () => {
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, snapshots: [sample(day + 100, 20, day + 1000)] });
    const packed = packProviderAccountUsageDaySummaryV1(summary);
    for (const invalid of [{ ...packed, lastSnapshot: packed.diagnosticRefs.length }, { ...packed, diagnosticRefs: [0] }]) {
      expect(() => openProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: day, accountMode: 'plain', content: { t: 'plain', v: invalid } })).toThrow();
    }
  });
});
