import { describe, expect, it } from 'vitest';

import { parseArgs, resolveProvidersRunTimeoutFallbackMs, resolveProvidersRunTimeoutMs } from '../../scripts/run-providers.mjs';

describe('providers run script args', () => {
  it('defaults flake retry to enabled', () => {
    const parsed = parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke']);

    expect(parsed.flakeRetry).toBe(true);
  });

  it('parses known flags and positional args', () => {
    const parsed = parseArgs([
      'node',
      'run-providers.mjs',
      'opencode',
      'smoke',
      '--update-baselines',
      '--strict-keys',
      '--flake-retry',
    ]);

    expect(parsed).toEqual({
      presetId: 'opencode',
      tier: 'smoke',
      updateBaselines: true,
      strictKeys: true,
      flakeRetry: true,
    });
  });

  it('allows explicit flake retry opt-out', () => {
    const parsed = parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--no-flake-retry']);

    expect(parsed.flakeRetry).toBe(false);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--bad-flag'])).toThrow(
      /Unknown flag/,
    );
  });

  it('rejects conflicting flake retry flags', () => {
    expect(() =>
      parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--flake-retry', '--no-flake-retry']),
    ).toThrow(/Conflicting flags/);
  });

  it('rejects unexpected extra positional args', () => {
    expect(() => parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', 'extra'])).toThrow(
      /Unexpected positional argument/,
    );
  });
});

describe('providers run script timeout', () => {
  it('uses a longer default timeout for all:smoke than a single-provider smoke run', () => {
    const allSmoke = resolveProvidersRunTimeoutFallbackMs({ presetId: 'all', tier: 'smoke' });
    const oneSmoke = resolveProvidersRunTimeoutFallbackMs({ presetId: 'opencode', tier: 'smoke' });
    expect(allSmoke).toBeGreaterThan(oneSmoke);
  });

  it('uses fallback for missing/invalid values', () => {
    expect(resolveProvidersRunTimeoutMs(undefined, 123_000)).toBe(123_000);
    expect(resolveProvidersRunTimeoutMs('0', 123_000)).toBe(123_000);
    expect(resolveProvidersRunTimeoutMs('-50', 123_000)).toBe(123_000);
    expect(resolveProvidersRunTimeoutMs('not-a-number', 123_000)).toBe(123_000);
  });

  it('parses positive values and clamps minimum', () => {
    expect(resolveProvidersRunTimeoutMs('120000', 123_000)).toBe(120_000);
    expect(resolveProvidersRunTimeoutMs('1000', 123_000)).toBe(60_000);
  });
});
