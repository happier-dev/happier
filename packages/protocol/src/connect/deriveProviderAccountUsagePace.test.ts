import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { deriveProviderAccountUsageEarlierWindowCurves, deriveProviderAccountUsagePace, readProviderAccountUsageWindowComparabilityReason } from './deriveProviderAccountUsagePace.js';

function snapshot(at = 250): ProviderAccountUsageSnapshotV1 {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
  return { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, unit: 'requests', utilizationPct: 50, resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] };
}

describe('accepted provider usage pace', () => {
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
