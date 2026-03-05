import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { supportsCodexVendorResume } from './vendorResumeSupport';

const ENV_KEYS = [
  'HAPPIER_EXPERIMENTAL_CODEX_ACP',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;

function captureEnv(): EnvSnapshot {
  return {
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
      HAPPIER_EXPERIMENTAL_CODEX_ACP: undefined,
    });
  });

  afterEach(() => {
    restoreEnv(baseline);
  });

  it('rejects by default', () => {
    expect(supportsCodexVendorResume({})).toBe(false);
  });

  it('allows when explicitly enabled via ACP for this spawn', () => {
    expect(supportsCodexVendorResume({ experimentalCodexAcp: true })).toBe(true);
  });

  it('does not allow when HAPPIER_EXPERIMENTAL_CODEX_ACP is set (settings-only)', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';
    expect(supportsCodexVendorResume({})).toBe(false);
  });

  it('does not allow when explicitly disabled for this spawn, even if env is set', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';
    expect(
      supportsCodexVendorResume({
        experimentalCodexAcp: false,
      }),
    ).toBe(false);
  });
});
