import { describe, expect, it } from 'vitest';

import { resolveAutomationPollingConfig } from './automationScheduler';

describe('resolveAutomationPollingConfig', () => {
  it('uses defaults when env is unset', () => {
    const config = resolveAutomationPollingConfig({} as NodeJS.ProcessEnv);

    expect(config).toEqual({
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });

  it('clamps values into configured ranges', () => {
    const config = resolveAutomationPollingConfig({
      HAPPIER_AUTOMATION_LEASE_MS: '1000',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: '9999999',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      leaseDurationMs: 5_000,
      heartbeatMs: 60_000,
    });
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
