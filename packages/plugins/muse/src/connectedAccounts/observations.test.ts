import { describe, expect, it } from 'vitest';
import { parseMuseMintCompletionObservation, parseMuseUsageObservation } from './observations.js';

describe('Muse sourced observations', () => {
  it('normalizes native notifications, read results and canonical allowance envelopes identically', () => {
    const usage = { observedAtMs: 1700000000000, tier: 'native-tier',
      weekly: { usedPercent: 12, resetsAtMs: 1700001000000 },
      window: { usedPercent: 35, resetsAtMs: 1700002000000, windowDurationMins: 300 } };
    const read = parseMuseUsageObservation({ usage });
    expect(read.status).toBe('supported');
    expect(parseMuseUsageObservation(usage)).toEqual(read);
    expect(parseMuseUsageObservation({ schemaVersion: 1, asOfMs: usage.observedAtMs,
      allowance: { tier: usage.tier, weekly: usage.weekly, window: usage.window } })).toEqual(read);
  });
  it('preserves source time, partial windows and over-quota without guessing durations', () => {
    expect(parseMuseUsageObservation({ usage: {
      observedAtMs: 1700000000000, tier: 'native-tier',
      weekly: { usedPercent: 135, resetsAtMs: 1700001000000 },
      window: { usedPercent: 40, windowDurationMins: 300 },
    } })).toMatchObject({ status: 'supported', observation: {
      observedAtMs: 1700000000000, planLabel: 'native-tier', limits: [
        { id: 'weekly', utilizationPct: 135, isExhausted: true, resetsAtMs: 1700001000000 },
        { id: 'window', utilizationPct: 40, windowDurationMs: 18000000 },
      ],
    } });
    const partial = parseMuseUsageObservation({ usage: { observedAtMs: 1700000000000, weekly: { usedPercent: 5 } } });
    if (partial.status !== 'supported') throw new Error('Expected partial usage');
    expect(partial.observation.limits).toHaveLength(1);
    expect(partial.observation.limits[0]).not.toHaveProperty('windowDurationMs');
  });

  it('distinguishes explicit absent allowance, no sample and malformed observations', () => {
    expect(parseMuseUsageObservation({ schemaVersion: 1, allowance: null, reason: 'api_key' })).toEqual({ status: 'unavailable', reason: 'api_key' });
    expect(parseMuseUsageObservation({ schemaVersion: 1, allowance: null, reason: 'no_allowance' })).toEqual({ status: 'unavailable', reason: 'no_allowance' });
    expect(parseMuseUsageObservation({})).toEqual({ status: 'unavailable', reason: 'server_sent_no_usage' });
    expect(parseMuseUsageObservation({ schemaVersion: 999, allowance: {} })).toEqual({ status: 'unavailable', reason: 'unsupported' });
    expect(parseMuseUsageObservation({ usage: { observedAtMs: 1700000000000, weekly: { usedPercent: -1 } } })).toEqual({ status: 'unavailable', reason: 'malformed' });
  });

  it('publishes only characterized mint usage with acquisition time and no raw secret fields', () => {
    const observation = parseMuseMintCompletionObservation({ api_key: 'synthetic-key', user_email: 'person@example.test',
      subs_tier_name: 'Synthetic plan', subs_usage: { weekly: { used_percent: 135, resets_at: '2026-11-16T00:00:00Z' }, window: { used_percent: 40, window_duration_mins: 300 } },
    }, 1700000000000);
    expect(observation).toMatchObject({ observedAtMs: 1700000000000, fetchedAtMs: 1700000000000,
      meters: [{ used: 135, utilizationPct: 100, resetsAt: Date.parse('2026-11-16T00:00:00Z') }, { used: 40, windowDurationMs: 18000000 }] });
    expect(observation?.meters[0]).not.toHaveProperty('windowDurationMs');
    expect(JSON.stringify(observation)).not.toContain('synthetic-key');
    expect(JSON.stringify(observation)).not.toContain('person@example.test');
    expect(parseMuseMintCompletionObservation({ is_subs_active: true, subs_usage: null }, 1700000000000)).toBeUndefined();
    expect(parseMuseMintCompletionObservation({ subs_usage: { weekly: { used_percent: -1 } } }, 1700000000000)).toBeUndefined();
    expect(parseMuseMintCompletionObservation({ subs_tier_name: '   ', subs_usage: { weekly: { used_percent: 5 } } }, 1700000000000)).not.toHaveProperty('planLabel');
  });
});
