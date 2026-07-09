import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileDaemonPaneAfterDaemonStarts } from './daemon_pane_reconcile.mjs';

test('reconcileDaemonPaneAfterDaemonStarts clears stale sign-in notice when daemon is running', () => {
  const out = reconcileDaemonPaneAfterDaemonStarts({
    title: 'daemon (SIGN-IN REQUIRED)',
    lines: ['Sign-in required', 'press "a" to run: hstack stack auth x login'],
    daemonPid: 123,
  });
  assert.equal(out.title, 'daemon (RUNNING)');
  assert.deepEqual(out.lines, ['Daemon is running', 'PID: 123']);
});

test('reconcileDaemonPaneAfterDaemonStarts preserves non-notice lines while still updating notice titles', () => {
  const out = reconcileDaemonPaneAfterDaemonStarts({
    title: 'daemon (SIGN-IN REQUIRED)',
    lines: ['[daemon] started'],
    daemonPid: 123,
  });
  assert.equal(out.title, 'daemon (RUNNING)');
  assert.deepEqual(out.lines, ['[daemon] started']);
});

test('reconcileDaemonPaneAfterDaemonStarts is a no-op when daemonPid is missing', () => {
  const out = reconcileDaemonPaneAfterDaemonStarts({
    title: 'daemon (SIGN-IN REQUIRED)',
    lines: ['Sign-in required'],
    daemonPid: null,
  });
  assert.equal(out.title, 'daemon (SIGN-IN REQUIRED)');
  assert.deepEqual(out.lines, ['Sign-in required']);
});

test('reconcileDaemonPaneAfterDaemonStarts clears stale notice when caller knows the daemon is running but does not have a pid yet', () => {
  const out = reconcileDaemonPaneAfterDaemonStarts({
    title: 'daemon (SIGN-IN REQUIRED)',
    lines: ['Sign-in required'],
    daemonPid: null,
    daemonRunning: true,
  });
  assert.equal(out.title, 'daemon (RUNNING)');
  assert.deepEqual(out.lines, ['Daemon is running']);
});

test('reconcileDaemonPaneAfterDaemonStarts clears stale start-conflict output after daemon recovers', () => {
  const out = reconcileDaemonPaneAfterDaemonStarts({
    title: 'daemon (NOT RUNNING)',
    lines: [
      '[daemon] Current release channel: unknown',
      '[daemon] Current CLI version: unknown',
      '[daemon] Stop the current daemon before starting another one.',
      '[daemon] exited (code=1, sig=null)',
      '[daemon] Another running daemon is already using the selected relay.',
      '[daemon] daemon start failed before the relay came up; keeping TUI running.',
    ],
    daemonPid: 10874,
    daemonRunning: true,
  });
  assert.equal(out.title, 'daemon (RUNNING)');
  assert.deepEqual(out.lines, ['Daemon is running', 'PID: 10874']);
});
