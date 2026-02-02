import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { supportsCodexVendorResume } from './vendorResumeSupport';

describe('supportsCodexVendorResume', () => {
  const prev = process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME;
  const prevAcp = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;

  beforeEach(() => {
    delete process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME;
    delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
  });

  afterEach(() => {
    if (typeof prev === 'string') process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME = prev;
    else delete process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME;
    if (typeof prevAcp === 'string') process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = prevAcp;
    else delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
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
});
