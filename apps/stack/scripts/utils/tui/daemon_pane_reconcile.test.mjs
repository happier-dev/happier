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

