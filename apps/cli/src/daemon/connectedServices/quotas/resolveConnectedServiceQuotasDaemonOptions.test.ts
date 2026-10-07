import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceQuotasDaemonOptions } from './resolveConnectedServiceQuotasDaemonOptions';

describe('resolveConnectedServiceQuotasDaemonOptions', () => {
  it('has no fetch deadline unless explicitly configured', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({});
    expect(opts.fetchTimeoutMs).toBeUndefined();
    expect(opts.discoveryEnabled).toBe(true);
    expect(opts.discoveryIntervalMs).toBe(15 * 60_000);
    expect(opts.failureBackoffMinMs).toBe(30_000);
    expect(opts.failureBackoffMaxMs).toBe(10 * 60_000);
    expect(opts.failureBackoffJitterPct).toBeCloseTo(0.2, 5);
  });

  it('uses provided fetch timeout when valid', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '12345',
    });
    expect(opts.fetchTimeoutMs).toBe(12_345);
  });

  it('opts into a persistence retry budget only when configured, without a private hundred-attempt ceiling', () => {
    expect(resolveConnectedServiceQuotasDaemonOptions({}).quotaPersistenceMaxConsecutiveFailures).toBeUndefined();
    expect(resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES: '1000',
    }).quotaPersistenceMaxConsecutiveFailures).toBe(1000);
  });

  it('honors configured fetch timeouts without private lower or upper ceilings', () => {
    const tooLow = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '100',
    });
    expect(tooLow.fetchTimeoutMs).toBe(100);

    const tooHigh = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: '999999',
    });
    expect(tooHigh.fetchTimeoutMs).toBe(999999);
  });

  it('falls back when fetch timeout is not an int', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS: 'nope',
    });
    expect(opts.fetchTimeoutMs).toBeUndefined();
  });

  it('parses discovery options from env', () => {
    const disabled = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED: 'false',
      HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_INTERVAL_MS: '1234',
    });
    expect(disabled.discoveryEnabled).toBe(false);
    expect(disabled.discoveryIntervalMs).toBe(1234);

    const enabled = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED: '1',
      HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_INTERVAL_MS: '90000',
    });
    expect(enabled.discoveryEnabled).toBe(true);
    expect(enabled.discoveryIntervalMs).toBe(90_000);
  });

  it('honors configured failure backoff and retains the percentage domain', () => {
    const opts = resolveConnectedServiceQuotasDaemonOptions({
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_MIN_MS: '999',
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_MAX_MS: '99999999',
      HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_JITTER_PCT: '2',
    });

    expect(opts.failureBackoffMinMs).toBe(999);
    expect(opts.failureBackoffMaxMs).toBe(99999999);
    expect(opts.failureBackoffJitterPct).toBe(1);
  });
});
