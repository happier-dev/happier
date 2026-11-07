import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_RESTART_VERIFY_POLL_MS,
  DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS,
  DEFAULT_DAEMON_START_WAIT_POLL_MS,
  DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS,
  DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS,
  readDaemonRestartVerifyPollMs,
  readDaemonRestartVerifyTimeoutMs,
  readDaemonStartWaitPollMs,
  readDaemonStartWaitTimeoutMs,
} from './startupWaitDefaults';

describe('daemon startup wait defaults', () => {
  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_START_WAIT_POLL_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS;
  });

  it('uses a source-runtime-safe default startup timeout', () => {
    expect(DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS).toBe(60_000);
    expect(readDaemonStartWaitTimeoutMs()).toBe(60_000);
  });

  it('keeps explicit startup wait overrides for tests and diagnostics', () => {
    process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS = '1234';
    process.env.HAPPIER_DAEMON_START_WAIT_POLL_MS = '7';

    expect(readDaemonStartWaitTimeoutMs()).toBe(1234);
    expect(readDaemonStartWaitPollMs()).toBe(7);
  });

  it('keeps the interactive and session-autostart poll defaults explicit', () => {
    expect(DEFAULT_DAEMON_START_WAIT_POLL_MS).toBe(100);
    expect(DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS).toBe(250);
    expect(readDaemonStartWaitPollMs()).toBe(100);
    expect(readDaemonStartWaitPollMs(DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS)).toBe(250);
  });

  it('uses the daemon startup budget for self-restart replacement verification', () => {
    expect(DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS).toBe(DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS);
    expect(DEFAULT_DAEMON_RESTART_VERIFY_POLL_MS).toBe(250);
    expect(readDaemonRestartVerifyTimeoutMs()).toBe(60_000);
    expect(readDaemonRestartVerifyPollMs()).toBe(250);

    process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS = '180000';
    expect(readDaemonRestartVerifyTimeoutMs()).toBe(180_000);

    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '45000';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '11';

    expect(readDaemonRestartVerifyTimeoutMs()).toBe(45_000);
    expect(readDaemonRestartVerifyPollMs()).toBe(11);
  });
});
