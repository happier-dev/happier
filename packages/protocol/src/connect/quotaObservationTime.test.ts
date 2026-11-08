import { describe, expect, it } from 'vitest';

import {
  compareConnectedServiceQuotaObservationRecency,
  isConnectedServiceQuotaObservationFresh,
  wasConnectedServiceQuotaObserved,
} from './quotaObservationTime.js';

describe('connected-service quota observation time', () => {
  it('distinguishes an epoch placeholder from an observed empty result', () => {
    expect(wasConnectedServiceQuotaObserved({ state: 'loaded_empty', observedAtMs: 0 })).toBe(false);
    expect(wasConnectedServiceQuotaObserved({ state: 'not_loaded', observedAtMs: 1_000 })).toBe(false);
    expect(wasConnectedServiceQuotaObserved({ state: 'loaded_empty', observedAtMs: 1_000 })).toBe(true);
    expect(wasConnectedServiceQuotaObserved({ state: 'loaded_data', observedAtMs: 1_000 })).toBe(true);
  });

  it('treats freshness as a bounded interval ending at the current clock', () => {
    expect(isConnectedServiceQuotaObservationFresh({ observedAtMs: 1_000, nowMs: 1_001, maxAgeMs: 60_000 }))
      .toBe(true);
    expect(isConnectedServiceQuotaObservationFresh({ observedAtMs: 10_000, nowMs: 1_000, maxAgeMs: 60_000 }))
      .toBe(false);
    expect(isConnectedServiceQuotaObservationFresh({ observedAtMs: 1_000, nowMs: 61_000, maxAgeMs: 60_000 }))
      .toBe(false);
  });

  it('lets current time recover from a retained future observation without accepting a new future one', () => {
    expect(compareConnectedServiceQuotaObservationRecency({
      existingObservedAtMs: 100_000,
      incomingObservedAtMs: 10_000,
      nowMs: 10_000,
    })).toBe('incoming_newer');
    expect(compareConnectedServiceQuotaObservationRecency({
      existingObservedAtMs: 10_000,
      incomingObservedAtMs: 100_000,
      nowMs: 10_000,
    })).toBe('incoming_future');
  });
});
