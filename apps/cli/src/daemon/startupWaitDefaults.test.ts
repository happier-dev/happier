import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS,
  DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS,
  readDaemonRestartVerifyTimeoutMs,
  readDaemonStartWaitTimeoutMs,
} from './startupWaitDefaults';

describe('daemon startup wait defaults', () => {
  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS;
  });

  it('uses a 60s default startup wait budget', () => {
    expect(DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS).toBe(60_000);
    expect(readDaemonStartWaitTimeoutMs()).toBe(60_000);
  });

  it('honors the daemon startup wait timeout env override', () => {
    process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS = '1234';

    expect(readDaemonStartWaitTimeoutMs()).toBe(1234);
  });

  it('aligns replacement verification with daemon startup by default', () => {
    expect(DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS).toBe(DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS);
    expect(readDaemonRestartVerifyTimeoutMs()).toBe(60_000);
  });

  it('honors the daemon restart verification timeout env override', () => {
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '45000';

    expect(readDaemonRestartVerifyTimeoutMs()).toBe(45_000);
  });
});
