import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, PROVIDER_ACCOUNT_USAGE_DAY_MS, ProviderAccountUsageSnapshotV1Schema,
  type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { buildProviderAccountUsageDaySummaryV1 } from './providerAccountUsageDaySummary.js';
import { deriveProviderAccountUsageEarlierWindowCurves, deriveProviderAccountUsagePace, deriveProviderAccountUsageUnusedCapacity,
  getProviderAccountUsageDerivationInterval, hasProviderAccountUsageWitnessedReset, readProviderAccountUsageWindowComparabilityReason,
  resolveProviderAccountUsageRecentHistoryRangesV1 } from './deriveProviderAccountUsagePace.js';

function snapshot(at = 250): ProviderAccountUsageSnapshotV1 {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
  return { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, unit: 'requests', utilizationPct: 50, resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] };
}

describe('accepted provider usage pace', () => {
  it('preserves a historical reset conflict hidden by a later backward provider clock', () => {
    const day = 86_400_000;
    const current = snapshot(20 * day + 9500);
    current.meters[0]!.resetsAt = 20 * day + 10000;
    const hidden = snapshot(20 * day + 9100); hidden.fetchedAtMs = 100;
    const last = snapshot(200);
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId: current.recordId, dayStartAtMs: 0, snapshots: [hidden, last] });
    expect(summary.windows[0]).toMatchObject({ firstObservedAtMs: 100, lastObservedAtMs: 200, lastSnapshot: { observedAtMs: 200 } });
    const full = deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: current.observedAtMs, history: [hidden, last] });
    const selection = resolveProviderAccountUsageRecentHistoryRangesV1({ current, daySummaries: [summary], nowMs: current.observedAtMs });
    if (selection.status !== 'available') throw new Error('exact clock range unavailable');
    const bounded = deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: current.observedAtMs,
      history: [hidden, last].filter(snapshot => selection.ranges.some(range => snapshot.fetchedAtMs >= range.startAtMs && snapshot.fetchedAtMs < range.endAtMs)) });
    expect(full).toEqual({ status: 'unavailable', reason: 'reset_changed' });
    expect(bounded).toEqual(full);
    expect(selection).toEqual({ status: 'available', ranges: [{ startAtMs: 0, endAtMs: day },
      { startAtMs: 20 * day + 9000, endAtMs: current.fetchedAtMs + 1 }] });
    console.info(JSON.stringify({ clockCounterexample: { current: current.observedAtMs, actualWindowStart: 20 * day + 9000,
      hidden: { fetchedAtMs: hidden.fetchedAtMs, observedAtMs: hidden.observedAtMs },
      retainedLast: { fetchedAtMs: last.fetchedAtMs, observedAtMs: last.observedAtMs }, full, bounded } }));
  });
  it('selects every actual meter window without fetching unrelated historical gaps or guessing legacy clock bounds', () => {
    const day = 86_400_000;
    const current = snapshot(20 * day + 9500);
    current.meters = [
      { ...current.meters[0]!, resetsAt: 21 * day, windowDurationMs: 7 * day },
      { ...current.meters[0]!, meterId: 'short', resetsAt: 20 * day + 10000 },
      { ...current.meters[0]!, meterId: 'unknown', resetsAt: null, windowDurationMs: undefined },
    ];
    const old = snapshot(5 * day + 500);
    old.meters[0]!.resetsAt = 5 * day + 1000;
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId: current.recordId, dayStartAtMs: 5 * day, snapshots: [old] });
    const input = { current, daySummaries: [summary], nowMs: current.observedAtMs };
    expect(resolveProviderAccountUsageRecentHistoryRangesV1(input)).toEqual({ status: 'available',
      ranges: [{ startAtMs: 14 * day, endAtMs: current.fetchedAtMs + 1 }] });
    const skewed = [6, 7].map(index => buildProviderAccountUsageDaySummaryV1({ recordId: current.recordId, dayStartAtMs: index * day,
      snapshots: [{ ...old, fetchedAtMs: index * day + 100, observedAtMs: current.observedAtMs - 100 }] }));
    expect(resolveProviderAccountUsageRecentHistoryRangesV1({ ...input, daySummaries: [summary, ...skewed] }))
      .toEqual({ status: 'available', ranges: [{ startAtMs: 6 * day, endAtMs: 8 * day },
        { startAtMs: 14 * day, endAtMs: current.fetchedAtMs + 1 }] });
    const { observedAtRange: _bounds, ...legacy } = summary;
    expect(resolveProviderAccountUsageRecentHistoryRangesV1({ ...input, daySummaries: [legacy] }))
      .toEqual({ status: 'unavailable', reason: 'unproven_clock_bounds' });
    expect(resolveProviderAccountUsageRecentHistoryRangesV1({ ...input, missingDays: [{ dayStartAtMs: 5 * day }] }))
      .toEqual({ status: 'unavailable', reason: 'unproven_clock_bounds' });
    expect(resolveProviderAccountUsageRecentHistoryRangesV1({ ...input, current: { ...current, meters: [current.meters[2]!] } }))
      .toEqual({ status: 'unavailable', reason: 'unknown_window' });
  });
  it('rejects ordinary same-window observations before deriving pace or comparing entitlement', () => {
    let entitlementReads = 0;
    let counterReads = 0;
    const observations = Array.from({ length: 100 }, (_, index) => {
      const value = snapshot(index + 1);
      // Transparent input instrumentation, not a mock of the pace/reset owner.
      Object.defineProperty(value, 'planLabel', { get() { entitlementReads++; return null; } });
      Object.defineProperty(value.meters[0]!, 'used', { get() { counterReads++; return 50; } });
      return value;
    });
    for (let index = 1; index < observations.length; index++) {
      expect(hasProviderAccountUsageWitnessedReset({ previous: observations[index - 1]!, current: observations[index]!,
        meterId: 'weekly', nowMs: index + 1 })).toBe(false);
    }
    expect(entitlementReads).toBe(0);
    expect(counterReads).toBe(0);
    const previous = snapshot(900);
    const current = snapshot(1000);
    current.meters[0]!.resetsAt = 2000;
    current.meters[0]!.used = 0;
    expect(hasProviderAccountUsageWitnessedReset({ previous, current, meterId: 'weekly', nowMs: 1000 })).toBe(true);
    current.planLabel = 'replaced entitlement';
    expect(hasProviderAccountUsageWitnessedReset({ previous, current, meterId: 'weekly', nowMs: 1000 })).toBe(false);
  });

  it('bounds derivation reuse by observed freshness and every ended historical window, including retired meters', () => {
    const current = snapshot();
    const earlier = snapshot(200);
    Object.assign(earlier.meters[0]!, { meterId: 'retired', resetsAt: 600, windowDurationMs: 600 });
    const history = [earlier];
    expect(getProviderAccountUsageDerivationInterval({ current, history, nowMs: 300 })).toEqual({ fromMs: 250, untilMs: 600 });
    const at = (nowMs: number) => ({ pace: deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', history, nowMs }),
      unused: deriveProviderAccountUsageUnusedCapacity({ history, nowMs }) });
    expect(at(599.9)).toEqual(at(300));
    expect(at(600).unused.windows).toHaveLength(1);
    expect(getProviderAccountUsageDerivationInterval({ current, history, nowMs: 600 })).toEqual({ fromMs: 600, untilMs: 1000 });
    expect(at(1000).pace).toEqual({ status: 'unavailable', reason: 'outside_window' });
    expect(getProviderAccountUsageDerivationInterval({ current, history, nowMs: 1000 })).toEqual({ fromMs: 1000, untilMs: 1250 });
    expect(at(1250).pace).toEqual({ status: 'unavailable', reason: 'stale' });
    expect(getProviderAccountUsageDerivationInterval({ current, history, nowMs: 1250 })).toEqual({ fromMs: 1250, untilMs: Infinity });
    expect(getProviderAccountUsageDerivationInterval({ current, history, nowMs: 200 })).toEqual({ fromMs: 0, untilMs: 250 });
    expect(at(200).pace).toEqual({ status: 'unavailable', reason: 'stale' });
    expect(getProviderAccountUsageDerivationInterval({ current: null, history, nowMs: 300 })).toEqual({ fromMs: 0, untilMs: 600 });
    for (const nowMs of [-1, NaN, Infinity]) expect(getProviderAccountUsageDerivationInterval({ current, history, nowMs })).toBeNull();
  });

  it('publishes the qualified observed curve and witnessed linear depletion through the pace owner', () => {
    const previous = snapshot(100); previous.meters[0]!.used = 10;
    const future = snapshot(300); future.meters[0]!.used = 70;
    const other = snapshot(80); other.recordId = 'pau:other';
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 300, history: [future, previous, previous, other] })).toMatchObject({
      status: 'available', observedCurve: [{ observedAtMs: 100, usedFraction: .1 }, { observedAtMs: 250, usedFraction: .5 }], depletesAtMs: 500,
    });
    const current = snapshot(); current.meters[0]!.used = 10;
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 300 })).toMatchObject({ status: 'available', depletesAtMs: null });
    previous.meters[0]!.unit = 'credits';
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 300, history: [previous] })).toMatchObject({ status: 'unavailable', reason: 'denominator_changed' });
    previous.meters[0]!.unit = 'requests'; previous.planLabel = 'changed tier';
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 300, history: [previous] })).toMatchObject({ status: 'unavailable', reason: 'entitlement_changed' });
  });
  it('does not substitute a percentage for an unusable known raw denominator', () => {
    const current = snapshot();
    Object.assign(current.meters[0]!, { used: 0, limit: 0, utilizationPct: 50 });
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 250 })).toMatchObject({ status: 'unavailable', reason: 'unknown_utilization' });
    Object.assign(current.meters[0]!, { used: null, limit: null });
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 250 })).toMatchObject({ status: 'available', usedFraction: .5, pace: 2 });
  });
  it('accepts truthful fractional counters while rejecting materially inconsistent sums', () => {
    const current = snapshot();
    Object.assign(current.meters[0]!, { used: 0.1, remaining: 0.2, limit: 0.3 });
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 250 })).toMatchObject({ status: 'available' });
    current.meters[0]!.remaining = 0.21;
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 250 })).toMatchObject({ status: 'unavailable', reason: 'inconsistent_counters' });
  });
  it('withholds inconsistent accepted empirical counters rather than counting them as confirmed samples', () => {
    const previous = snapshot(100);
    Object.assign(previous.meters[0]!, { used: 20, remaining: 10 });
    const current = snapshot();
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 250, history: [previous] })).toMatchObject({ status: 'unavailable', reason: 'inconsistent_counters' });
    previous.meters[0]!.remaining = 80;
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 250, history: [previous] })).toMatchObject({ status: 'available', sampleCount: 2 });
  });
  it('does not let completed historical cycles poison a fresh current-window pace', () => {
    const previous = snapshot(250); previous.planLabel = 'old tier';
    const completed = snapshot(1000); completed.planLabel = 'old tier';
    const current = snapshot(1250); current.meters[0]!.resetsAt = 2000;
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 1250, history: [previous, completed] })).toMatchObject({ status: 'available', pace: 2, sampleCount: 1 });
  });
  it('withholds a non-renewing next window before treating zero elapsed as a usable reset witness', () => {
    const current = snapshot(1000); current.meters[0]!.resetsAt = 2000;
    current.subscription = { status: 'subscribed', renewal: 'off', observedAtMs: 1000, staleAfterMs: 1000, currentPeriodEndAtMs: 1000 };
    expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'weekly', nowMs: 1000 })).toMatchObject({ status: 'unavailable', reason: 'non_renewing_end' });
  });
  it('recognizes a witnessed aligned subscription rollover without accepting a changed entitlement', () => {
    const previous = snapshot();
    previous.subscription = { status: 'subscribed', renewal: 'on', observedAtMs: 250, staleAfterMs: 2000, currentPeriodStartAtMs: 0, currentPeriodEndAtMs: 1000 };
    const current = snapshot(1250); current.meters[0]!.resetsAt = 2000;
    current.subscription = { ...previous.subscription, observedAtMs: 1250, currentPeriodStartAtMs: 1000, currentPeriodEndAtMs: 2000 };
    expect(readProviderAccountUsageWindowComparabilityReason({ previous, current, meterId: 'weekly' })).toBeNull();
    current.subscription.renewal = 'off';
    expect(readProviderAccountUsageWindowComparabilityReason({ previous, current, meterId: 'weekly' })).toBe('entitlement_changed');
  });
  it('projects observed utilization from witnessed elapsed time without advancing old counters to now', () => {
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 500 })).toMatchObject({ status: 'available', usedFraction: .5, elapsedFraction: .25, pace: 2, projectedResetUtilizationFraction: 2, evenPaceFraction: .25 });
  });
  it('uses each flat weekly window’s latest stored reading to project unused capacity', () => {
    const day = PROVIDER_ACCOUNT_USAGE_DAY_MS;
    const flat = (observedDay: number, resetDay: number) => {
      const value = snapshot(observedDay * day);
      Object.assign(value.meters[0]!, { used: 20, utilizationPct: 20, resetsAt: resetDay * day, windowDurationMs: 7 * day });
      return ProviderAccountUsageSnapshotV1Schema.parse(value);
    };
    const first = flat(1, 7);
    const middle = flat(3, 7);
    const latest = flat(6, 7);
    const nextFirst = flat(8, 14);
    const nextMiddle = flat(10, 14);
    const nextLatest = flat(13, 14);
    const currentWindow = { snapshot: latest, meterId: 'weekly', nowMs: 6 * day };
    const start = { observedAtMs: day, usedFraction: .2 };
    const end = { observedAtMs: 6 * day, usedFraction: .2 };
    expect(deriveProviderAccountUsagePace({ ...currentWindow, history: [first, middle] }))
      .toMatchObject({ status: 'available', usedFraction: .2, elapsedFraction: 6 / 7, pace: expect.closeTo(7 / 30), sampleCount: 3,
        observedCurve: [start, { observedAtMs: 3 * day, usedFraction: .2 }, end] });
    expect(deriveProviderAccountUsagePace({ ...currentWindow, history: [first] }))
      .toMatchObject({ status: 'available', sampleCount: 2, observedCurve: [start, end] });

    const projected = { status: 'available', unusedAmount: expect.closeTo(230 / 3), unusedFraction: expect.closeTo(23 / 30),
      unit: 'requests', sampleCount: 3, qualification: 'estimated', method: 'linear_pace_at_last_observation' };
    const firstWindow = { window: { windowStartAtMs: 0, resetAtMs: 7 * day }, value: { ...projected, observedAtMs: 6 * day } };
    const secondWindow = { window: { windowStartAtMs: 7 * day, resetAtMs: 14 * day }, value: { ...projected, observedAtMs: 13 * day } };
    expect(deriveProviderAccountUsageUnusedCapacity({ history: [first, middle, latest, nextFirst, nextMiddle, nextLatest], nowMs: 14 * day }))
      .toMatchObject({ historyStatus: 'returned_page', windows: [firstWindow, secondWindow] });
    expect(deriveProviderAccountUsageUnusedCapacity({ history: [first, middle, nextFirst, nextMiddle, nextLatest], nowMs: 14 * day }))
      .toMatchObject({ historyStatus: 'returned_page', windows: [
        { ...firstWindow, value: { ...firstWindow.value, observedAtMs: 3 * day, unusedAmount: expect.closeTo(160 / 3),
          unusedFraction: expect.closeTo(8 / 15), sampleCount: 2 } },
        secondWindow,
      ] });
  });
  it('withholds zero elapsed, stale, unknown window and incompatible history', () => {
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(0), meterId: 'weekly', nowMs: 0 })).toMatchObject({ status: 'unavailable', reason: 'zero_elapsed' });
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 1250 })).toMatchObject({ status: 'unavailable', reason: 'stale' });
    const unknown = snapshot(); delete unknown.meters[0]!.windowDurationMs;
    expect(deriveProviderAccountUsagePace({ snapshot: unknown, meterId: 'weekly', nowMs: 250 })).toMatchObject({ status: 'unavailable', reason: 'unknown_window' });
    const previous = snapshot(100); previous.meters[0]!.limit = 200;
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 250, history: [previous] })).toMatchObject({ status: 'unavailable', reason: 'denominator_changed' });
    previous.meters[0]!.limit = 100; previous.meters[0]!.used = 60;
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 250, history: [previous] })).toMatchObject({ status: 'unavailable', reason: 'counter_reset' });
  });
  it('breaks changed entitlement and exposes empirical spread only for comparable accepted samples', () => {
    const previous = snapshot(100); previous.meters[0]!.used = 10;
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 250, history: [previous] })).toMatchObject({ status: 'available', sampleCount: 2, empiricalRange: { min: 1, max: 2 } });
    previous.planLabel = 'changed';
    expect(deriveProviderAccountUsagePace({ snapshot: snapshot(), meterId: 'weekly', nowMs: 250, history: [previous] })).toMatchObject({ status: 'unavailable', reason: 'entitlement_changed' });
  });
});

describe('earlier comparable window curves', () => {
  // The current window is [1000, 2000); earlier windows of the same record end at 1000 and 0.
  const at = (observedAtMs: number, used: number, resetsAt: number) => {
    const value = snapshot(observedAtMs);
    Object.assign(value.meters[0]!, { used, utilizationPct: used, resetsAt });
    return value;
  };
  const current = at(1500, 60, 2000);

  it('groups accepted history into each ended window of the same meter on the elapsed-share axis', () => {
    const result = deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'weekly', history: [
      at(1200, 15, 2000), // the current window's own reading: never an earlier curve
      at(500, 40, 1000), at(250, 10, 1000), at(750, 90, 1000),
    ] });
    expect(result).toEqual({ status: 'available', curves: [{ window: expect.objectContaining({ resetAtMs: 1000, windowStartAtMs: 0 }),
      points: [{ elapsedFraction: 0.25, usedFraction: 0.1 }, { elapsedFraction: 0.5, usedFraction: 0.4 }, { elapsedFraction: 0.75, usedFraction: 0.9 }] }],
      excluded: [] });
  });

  it('leaves out an earlier window the comparability owner rejects, with its reason, and needs two readings for a curve', () => {
    const changedLimit = at(400, 30, 1000); changedLimit.meters[0]!.limit = 200;
    const lone = at(-500 + 1000, 10, 1000); // a single reading of an otherwise comparable window
    const result = deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'weekly', history: [changedLimit, at(600, 70, 1000)] });
    expect(result).toMatchObject({ status: 'available', curves: [], excluded: [{ window: expect.objectContaining({ resetAtMs: 1000 }), reason: 'denominator_changed' }] });
    expect(deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'weekly', history: [lone] }))
      .toMatchObject({ status: 'available', curves: [], excluded: [{ reason: 'single_reading' }] });
  });

  it('has no curve without a known current window or any history', () => {
    const unknown = at(1500, 60, 2000); delete (unknown.meters[0] as { windowDurationMs?: number }).windowDurationMs;
    expect(deriveProviderAccountUsageEarlierWindowCurves({ current: unknown, meterId: 'weekly', history: [at(500, 40, 1000)] }))
      .toEqual({ status: 'unavailable', reason: 'unknown_window' });
    expect(deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'weekly' })).toEqual({ status: 'unavailable', reason: 'not_loaded' });
  });
});

describe('second-level reset window identity', () => {
  it('does not report reset_changed for same-second reset jitter, but does for a real reset', () => {
    const previous = snapshot(1100);
    previous.meters[0]!.resetsAt = 2000;
    previous.meters[0]!.used = 20;
    const jitter = snapshot(1500);
    jitter.meters[0]!.resetsAt = 2400;
    jitter.meters[0]!.used = 30;
    const jitterPace = deriveProviderAccountUsagePace({ snapshot: jitter, meterId: 'weekly', nowMs: 1500, history: [previous] });
    expect(jitterPace).not.toEqual({ status: 'unavailable', reason: 'reset_changed' });
    expect(jitterPace).toMatchObject({ status: 'available', window: { resetAtMs: 2400 } });

    const resetWindowPrevious = snapshot(2100);
    resetWindowPrevious.meters[0]!.resetsAt = 2000;
    resetWindowPrevious.meters[0]!.used = 20;
    const realReset = snapshot(2200);
    realReset.meters[0]!.resetsAt = 3000;
    realReset.meters[0]!.used = 30;
    expect(deriveProviderAccountUsagePace({ snapshot: realReset, meterId: 'weekly', nowMs: 2500, history: [resetWindowPrevious] })).toEqual({ status: 'unavailable', reason: 'reset_changed' });
  });

  it('uses the same identity for unused capacity and earlier curves', () => {
    const previous = snapshot(1100);
    previous.meters[0]!.resetsAt = 2000;
    previous.meters[0]!.used = 20;
    const jitter = snapshot(1200);
    jitter.meters[0]!.resetsAt = 2400;
    jitter.meters[0]!.used = 30;
    const unused = deriveProviderAccountUsageUnusedCapacity({ history: [previous, jitter], nowMs: 2500 });
    expect(unused.windows).toHaveLength(1);
    const current = snapshot(3200);
    current.meters[0]!.resetsAt = 4000;
    const curves = deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'weekly', history: [previous, jitter] });
    expect(curves.status).toBe('available');
    if (curves.status === 'available') expect(curves.curves).toHaveLength(1);
  });
});
