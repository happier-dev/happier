import { describe, expect, it, vi } from 'vitest';

import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';
import { resolveAutomationPollingConfig } from './automationScheduler';

describe('resolveAutomationPollingConfig', () => {
  it('uses defaults when env is unset', () => {
    const config = resolveAutomationPollingConfig({} as NodeJS.ProcessEnv);

    expect(config).toEqual({
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });

  it('clamps heartbeat cadence below half of the resolved lease', () => {
    const config = resolveAutomationPollingConfig({
      HAPPIER_AUTOMATION_LEASE_MS: '1000',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: '9999999',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      leaseDurationMs: 5_000,
      heartbeatMs: 2_500,
    });
  });

  it('fires the first resolved heartbeat before the lease can expire', async () => {
    vi.useFakeTimers();
    try {
      const config = resolveAutomationPollingConfig({
        HAPPIER_AUTOMATION_LEASE_MS: '5000',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '60000',
      } as NodeJS.ProcessEnv);
      const onHeartbeat = vi.fn(async () => {});
      const heartbeat = startAutomationLeaseHeartbeat({
        heartbeatMs: config.heartbeatMs,
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
    const config = resolveAutomationPollingConfig({
      HAPPIER_AUTOMATION_LEASE_MS: 'NaN',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: 'x',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });
});
