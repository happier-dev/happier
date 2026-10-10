import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '../../connect/providerAccountUsagePrimitives.js';
import { evaluatePendingResetStartReadinessV1 } from './pendingResetStartReadinessV1.js';

function snapshot(at: number, resetAt: number): ProviderAccountUsageSnapshotV1 {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' } as const;
  return { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
    accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at,
    staleAfterMs: 1_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
    meters: [{ meterId: 'window', label: 'Window', used: 50, limit: 100, unit: 'requests',
      utilizationPct: 50, resetsAt: resetAt, windowDurationMs: 1_000, status: 'ok', details: {} }] };
}

function readinessInput() {
  const witness = snapshot(500, 1_000);
  const reset = { source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' } as const,
    recordId: witness.recordId, meterId: 'window', witness: { id: 'history', observedAtMs: 500 } };
  return { reset, witness, current: snapshot(1_000, 2_000), nowMs: 1_000, authorityCurrent: true };
}

describe('Pending reset start readiness', () => {
  it('projects the same opened witness decision without persisting protected reset dates', () => {
    const input = readinessInput();
    const witness = input.witness;
    expect(evaluatePendingResetStartReadinessV1({ ...input, authorityCurrent: false })).toEqual({ status: 'waiting', reason: 'authority_unavailable' });
    expect(evaluatePendingResetStartReadinessV1({ ...input, witness: null })).toEqual({ status: 'waiting', reason: 'witness_unavailable' });
    expect(evaluatePendingResetStartReadinessV1({ ...input, current: witness, nowMs: 500 })).toEqual({ status: 'waiting', reason: 'before_reset', nextCheckAtMs: 1_000 });
    expect(evaluatePendingResetStartReadinessV1({ ...input, current: witness })).toEqual({ status: 'waiting', reason: 'reset_not_observed' });
    expect(evaluatePendingResetStartReadinessV1(input)).toEqual({ status: 'ready' });
    expect(evaluatePendingResetStartReadinessV1({ ...input, current: { ...input.current, staleAfterMs: 10_000 }, nowMs: 2_000 })).toEqual({ status: 'waiting', reason: 'window_expired' });
  });
  it('refuses a historical witness from a different accepted observation', () => {
    const input = readinessInput();
    expect(evaluatePendingResetStartReadinessV1({ ...input, witness: { ...input.witness, fetchedAtMs: 501 } })).toEqual({ status: 'waiting', reason: 'witness_unavailable' });
  });
  it('refuses a historical observation that did not load usage', () => {
    const input = readinessInput();
    expect(evaluatePendingResetStartReadinessV1({ ...input, witness: { ...input.witness, state: 'loaded_empty' } })).toEqual({ status: 'waiting', reason: 'witness_unavailable' });
  });
  it('projects stale current usage before reset while retaining the actual future reset wake', () => {
    const input = readinessInput();
    expect(evaluatePendingResetStartReadinessV1({ ...input, current: { ...input.witness, staleAfterMs: 100 }, nowMs: 750 })).toEqual({ status: 'waiting', reason: 'quota_stale', nextCheckAtMs: 1_000 });
  });
  it('projects changed entitlement before reset while retaining the actual future reset wake', () => {
    const input = readinessInput();
    expect(evaluatePendingResetStartReadinessV1({ ...input, current: { ...input.witness, planLabel: 'changed' }, nowMs: 750 })).toEqual({ status: 'waiting', reason: 'entitlement_changed', nextCheckAtMs: 1_000 });
  });
  it('withholds a geometric rollover extending beyond a witnessed non-renewing entitlement end', () => {
    const input = readinessInput();
    const subscription = { status: 'subscribed' as const, renewal: 'off' as const,
      observedAtMs: 500, staleAfterMs: 1_000, currentPeriodEndAtMs: 1_000 };
    expect(evaluatePendingResetStartReadinessV1({ ...input,
      witness: { ...input.witness, subscription }, current: { ...input.current, subscription },
    })).toEqual({ status: 'waiting', reason: 'entitlement_changed' });
  });
  it('does not treat a recent fetch of a pre-reset provider observation as an observed rollover', () => {
    const input = readinessInput();
    expect(evaluatePendingResetStartReadinessV1({ ...input,
      current: { ...input.current, observedAtMs: 500, fetchedAtMs: 1_000 },
    })).toEqual({ status: 'waiting', reason: 'reset_not_observed' });
  });
  it('withholds a stale provider observation even when its record was fetched recently', () => {
    const input = readinessInput();
    expect(evaluatePendingResetStartReadinessV1({ ...input,
      current: { ...input.current, observedAtMs: 0, fetchedAtMs: 1_000, staleAfterMs: 500 },
    })).toEqual({ status: 'waiting', reason: 'quota_stale' });
  });
});
