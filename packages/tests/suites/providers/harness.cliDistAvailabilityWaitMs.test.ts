import { describe, expect, it } from 'vitest';

import { resolveCliDistAvailabilityWaitMs } from '../../src/testkit/providers/harness';

describe('providers harness: CLI dist availability wait', () => {
  it('defaults to 180s when unset', () => {
    expect(resolveCliDistAvailabilityWaitMs(undefined)).toBe(180_000);
  });

  it('clamps to minimum 30s', () => {
    expect(resolveCliDistAvailabilityWaitMs('1')).toBe(30_000);
    expect(resolveCliDistAvailabilityWaitMs('25000')).toBe(30_000);
  });

  it('clamps to maximum 600s', () => {
    expect(resolveCliDistAvailabilityWaitMs('700000')).toBe(600_000);
  });

  it('accepts valid values inside bounds', () => {
    expect(resolveCliDistAvailabilityWaitMs('120000')).toBe(120_000);
    expect(resolveCliDistAvailabilityWaitMs('300000')).toBe(300_000);
  });
});
