import { describe, expect, it } from 'vitest';

import { resolveAutomationPollingConfig } from './automationScheduler';

describe('resolveAutomationPollingConfig', () => {
  it('uses defaults when env is unset', () => {
    const config = resolveAutomationPollingConfig({} as NodeJS.ProcessEnv);

    expect(config).toEqual({
      claimPollMs: 5_000,
      assignmentsRefreshMs: 30_000,
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });

  it('clamps values into configured ranges', () => {
    const config = resolveAutomationPollingConfig({
      HAPPIER_AUTOMATION_CLAIM_POLL_MS: '100',
      HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '9999999',
      HAPPIER_AUTOMATION_LEASE_MS: '1000',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: '9999999',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      claimPollMs: 1_000,
      assignmentsRefreshMs: 10 * 60_000,
      leaseDurationMs: 5_000,
      heartbeatMs: 60_000,
    });
  });

  it('falls back for non-numeric values', () => {
    const config = resolveAutomationPollingConfig({
      HAPPIER_AUTOMATION_CLAIM_POLL_MS: 'abc',
      HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '',
      HAPPIER_AUTOMATION_LEASE_MS: 'NaN',
      HAPPIER_AUTOMATION_HEARTBEAT_MS: 'x',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      claimPollMs: 5_000,
      assignmentsRefreshMs: 30_000,
      leaseDurationMs: 30_000,
      heartbeatMs: 15_000,
    });
  });
});
