import { describe, expect, it } from 'vitest';

import { resolveCliDistAvailabilityWaitMs, resolveCliDistBuildTimeoutMs } from '../../src/testkit/providers/harness';

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

describe('providers harness: CLI dist build timeout', () => {
  it('defaults to 240s when unset', () => {
    expect(resolveCliDistBuildTimeoutMs(undefined)).toBe(240_000);
  });

  it('clamps to minimum 60s', () => {
    expect(resolveCliDistBuildTimeoutMs('1')).toBe(60_000);
    expect(resolveCliDistBuildTimeoutMs('59000')).toBe(60_000);
  });

  it('clamps to maximum 30min', () => {
    expect(resolveCliDistBuildTimeoutMs('99999999')).toBe(1_800_000);
  });

  it('accepts valid values inside bounds', () => {
    expect(resolveCliDistBuildTimeoutMs('300000')).toBe(300_000);
    expect(resolveCliDistBuildTimeoutMs('900000')).toBe(900_000);
  });
});
