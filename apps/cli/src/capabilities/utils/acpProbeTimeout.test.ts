import { afterEach, describe, expect, it } from 'vitest';

import { resolveAcpProbeTimeoutMs } from './acpProbeTimeout';

describe('resolveAcpProbeTimeoutMs', () => {
  afterEach(() => {
    delete process.env.HAPPIER_ACP_PROBE_TIMEOUT_MS;
    delete process.env.HAPPIER_ACP_PROBE_TIMEOUT_GEMINI_MS;
  });

  it('uses default timeout when no overrides are present', () => {
    expect(resolveAcpProbeTimeoutMs('gemini')).toBe(8_000);
  });

  it('caps transport-derived timeout to avoid excessively long capability probes', () => {
    expect(resolveAcpProbeTimeoutMs('gemini', 120_000)).toBe(30_000);
  });

  it('keeps default timeout when transport init timeout is smaller', () => {
    expect(resolveAcpProbeTimeoutMs('gemini', 2_000)).toBe(8_000);
  });

  it('prefers per-agent environment override over transport timeout', () => {
    process.env.HAPPIER_ACP_PROBE_TIMEOUT_GEMINI_MS = '15000';
    expect(resolveAcpProbeTimeoutMs('gemini', 120_000)).toBe(15_000);
  });

  it('uses global environment override when no per-agent override exists', () => {
    process.env.HAPPIER_ACP_PROBE_TIMEOUT_MS = '25000';
    expect(resolveAcpProbeTimeoutMs('gemini', 120_000)).toBe(25_000);
  });
});
