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

  it('allows by default (app-server)', () => {
    expect(supportsCodexVendorResume({})).toBe(true);
  });

  it('allows when explicitly enabled via ACP for this spawn', () => {
    expect(supportsCodexVendorResume({ experimentalCodexAcp: true })).toBe(true);
  });

  it('allows when codexBackendMode is explicitly set to acp', () => {
    expect(
      supportsCodexVendorResume({
        codexBackendMode: 'acp',
        experimentalCodexAcp: false,
      }),
    ).toBe(true);
  });

  it('allows when codexBackendMode is explicitly set to appServer', () => {
    expect(
      supportsCodexVendorResume({
        codexBackendMode: 'appServer',
      }),
    ).toBe(true);
  });

  it('prefers explicit codexBackendMode over the legacy ACP flag', () => {
    expect(
      supportsCodexVendorResume({
        codexBackendMode: 'mcp',
        experimentalCodexAcp: true,
      }),
    ).toBe(false);
  });

  it('ignores HAPPIER_EXPERIMENTAL_CODEX_ACP env (capability is derived from spawn params)', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';
    expect(supportsCodexVendorResume({})).toBe(true);
  });

  it('does not allow when codexBackendMode is explicitly set to mcp', () => {
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';
    expect(
      supportsCodexVendorResume({
        codexBackendMode: 'mcp',
      }),
    ).toBe(false);
  });
});
