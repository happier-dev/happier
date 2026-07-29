import { describe, expect, it } from 'vitest';

import { resolveDaemonSessionRunnerRestartTimeoutMs } from './controlClient';

describe('resolveDaemonSessionRunnerRestartTimeoutMs', () => {
  it('defaults above the daemon respawn-completion budget', () => {
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({})).toBe(75_000);
  });

  it('honors bounded overrides', () => {
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({
      HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS: '90000',
    })).toBe(90_000);
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({
      HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS: '999999',
    })).toBe(300_000);
  });
});
