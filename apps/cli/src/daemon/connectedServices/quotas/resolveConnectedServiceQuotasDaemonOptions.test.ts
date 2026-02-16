import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceQuotasDaemonOptions } from './resolveConnectedServiceQuotasDaemonOptions';

describe('resolveConnectedServiceQuotasDaemonOptions', () => {
  it('defaults fetch timeout when unset', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({});
    expect(opts.fetchTimeoutMs).toBe(15_000);
  });

  it('uses provided fetch timeout when valid', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '12345',
    });
    expect(opts.fetchTimeoutMs).toBe(12_345);
  });

  it('clamps fetch timeout to bounds', () => {
    const tooLow = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '100',
    });
    expect(tooLow.fetchTimeoutMs).toBe(1_000);

    const tooHigh = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '999999',
    });
    expect(tooHigh.fetchTimeoutMs).toBe(120_000);
  });

  it('falls back when fetch timeout is not an int', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: 'nope',
    });
    expect(opts.fetchTimeoutMs).toBe(15_000);
  });
});

