import { describe, expect, it } from 'vitest';

import { parseArgs, resolveProvidersRunTimeoutMs } from '../../scripts/run-providers.mjs';

describe('providers run script args', () => {
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

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--bad-flag'])).toThrow(
      /Unknown flag/,
    );
  });

  it('rejects unexpected extra positional args', () => {
    expect(() => parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', 'extra'])).toThrow(
      /Unexpected positional argument/,
    );
  });
});

describe('providers run script timeout', () => {
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
