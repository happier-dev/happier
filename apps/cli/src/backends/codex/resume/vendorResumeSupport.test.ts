import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { supportsCodexVendorResume } from './vendorResumeSupport';

const ENV_KEYS = [
  'HAPPIER_EXPERIMENTAL_CODEX_RESUME',
  'HAPPIER_EXPERIMENTAL_CODEX_ACP',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;

function captureEnv(): EnvSnapshot {
  return {
    HAPPIER_EXPERIMENTAL_CODEX_RESUME: process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME,
    HAPPIER_EXPERIMENTAL_CODEX_ACP: process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
}

describe('supportsCodexVendorResume', () => {
  let baseline: EnvSnapshot;

  beforeEach(() => {
    baseline = captureEnv();
    restoreEnv({
      HAPPIER_EXPERIMENTAL_CODEX_RESUME: undefined,
      HAPPIER_EXPERIMENTAL_CODEX_ACP: undefined,
    });
  });

  afterEach(() => {
    restoreEnv(baseline);
  });

  it('rejects by default', () => {
    expect(supportsCodexVendorResume({})).toBe(false);
  });

  it('allows when explicitly enabled for this spawn', () => {
    expect(supportsCodexVendorResume({ experimentalCodexResume: true })).toBe(true);
  });

  it('allows when explicitly enabled via ACP for this spawn', () => {
    expect(supportsCodexVendorResume({ experimentalCodexAcp: true })).toBe(true);
  });

  it('allows when HAPPIER_EXPERIMENTAL_CODEX_RESUME is set', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME = '1';
    expect(supportsCodexVendorResume({})).toBe(true);
  });

  it('allows when HAPPIER_EXPERIMENTAL_CODEX_ACP is set', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';
    expect(supportsCodexVendorResume({})).toBe(true);
  });

  it('accepts truthy env values case-insensitively with whitespace', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME = '  YeS ';
    expect(supportsCodexVendorResume({})).toBe(true);
  });

  it.each(['0', 'false', 'no', 'enabled', ''])(
    'rejects malformed env values: %p',
    (envValue) => {
      process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME = envValue;
      process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = envValue;
      expect(supportsCodexVendorResume({})).toBe(false);
    },
  );

  it('treats per-spawn explicit false as no-op when env enables support', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME = '1';
    expect(
      supportsCodexVendorResume({
        experimentalCodexResume: false,
        experimentalCodexAcp: false,
      }),
    ).toBe(true);
  });
});
