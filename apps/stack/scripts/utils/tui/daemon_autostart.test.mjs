import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAttemptTuiDaemonAutostart } from './daemon_autostart.mjs';

test('shouldAttemptTuiDaemonAutostart requires stack context and start-like invocation', () => {
  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: '',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );

  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: false,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );
});

test('shouldAttemptTuiDaemonAutostart fails closed when daemon is not expected, server is unknown, creds missing, or daemon is running', () => {
  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: false,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );

  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: '',
      authed: true,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );

  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: false,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );

  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: 123,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );
});

test('shouldAttemptTuiDaemonAutostart rate limits and de-dupes concurrent attempts', () => {
  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: null,
      inProgress: true,
      lastAttemptAtMs: 0,
      nowMs: 1000,
      minIntervalMs: 10_000,
    }),
    false
  );

  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 5000,
      nowMs: 1000 + 5000,
      minIntervalMs: 10_000,
    }),
    false
  );
});

test('shouldAttemptTuiDaemonAutostart allows attempt when all conditions are satisfied', () => {
  assert.equal(
    shouldAttemptTuiDaemonAutostart({
      stackName: 'repo-dev-abc',
      isStartLike: true,
      startDaemon: true,
      internalServerUrl: 'http://127.0.0.1:1234',
      authed: true,
      daemonPid: null,
      inProgress: false,
      lastAttemptAtMs: 0,
      nowMs: 20_000,
      minIntervalMs: 10_000,
    }),
    true
  );
});

