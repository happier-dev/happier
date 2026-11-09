import { describe, expect, it, vi } from 'vitest';

import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';
import { resolveAutomationPollingConfig } from './automationScheduler';

describe('resolveAutomationPollingConfig', () => {
  it('uses defaults when env is unset', () => {
    const config = resolveAutomationPollingConfig({ NODE_ENV: 'test' });

    expect(config).toEqual({
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });

  it('preserves the explicit lease request and derives its heartbeat ceiling from that lease', () => {
    const config = resolveAutomationPollingConfig({ NODE_ENV: 'test',
      HAPPIER_AUTOMATION_LEASE_MS: '1000',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: '9999999',
    });

    expect(config).toEqual({
      leaseDurationMs: 1_000,
      heartbeatMs: 500,
    });
  });

  it('derives a positive heartbeat for the smallest positive lease request', () => {
    expect(resolveAutomationPollingConfig({ HAPPIER_AUTOMATION_LEASE_MS: '1' }))
      .toEqual({ leaseDurationMs: 1, heartbeatMs: 1 });
  });

  it('fires the first resolved heartbeat before the lease can expire', async () => {
    vi.useFakeTimers();
    try {
      const config = resolveAutomationPollingConfig({ NODE_ENV: 'test',
        HAPPIER_AUTOMATION_LEASE_MS: '5000',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '60000',
      });
      const onHeartbeat = vi.fn(async () => Date.now() + config.leaseDurationMs);
      const heartbeat = startAutomationLeaseHeartbeat({
        heartbeatMs: config.heartbeatMs,
        leaseExpiresAtMs: Date.now() + config.leaseDurationMs,
        onHeartbeat,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(config.leaseDurationMs - 1);

      expect(onHeartbeat).toHaveBeenCalledOnce();
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back for non-numeric values', () => {
    const config = resolveAutomationPollingConfig({ NODE_ENV: 'test',
      HAPPIER_AUTOMATION_LEASE_MS: 'NaN',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: 'x',
    });

    expect(config).toEqual({
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });
});
