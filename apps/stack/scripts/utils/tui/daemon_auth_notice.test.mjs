import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDaemonAuthNotice } from './daemon_auth_notice.mjs';

test('buildDaemonAuthNotice returns an auth-required banner when daemon is not running and credentials are missing', () => {
  const notice = buildDaemonAuthNotice({
    stackName: 'repo-dev-abc123',
    internalServerUrl: 'http://127.0.0.1:53288',
    daemonPid: null,
    authed: false,
    startDaemon: true,
  });
  assert.equal(notice.show, true);
  assert.ok(notice.summaryLines.join('\n').toLowerCase().includes('sign-in required'));
  assert.equal(notice.paneTitle, 'daemon (SIGN-IN REQUIRED)');
  assert.ok(notice.paneLines.join('\n').includes('press "a"'));
});

test('buildDaemonAuthNotice returns no notice when daemon is running', () => {
  const notice = buildDaemonAuthNotice({
    stackName: 'repo-dev-abc123',
    internalServerUrl: 'http://127.0.0.1:53288',
    daemonPid: 123,
    authed: false,
    startDaemon: true,
  });
  assert.equal(notice.show, false);
});

test('buildDaemonAuthNotice indicates waiting when server url is missing', () => {
  const notice = buildDaemonAuthNotice({
    stackName: 'repo-dev-abc123',
    internalServerUrl: '',
    daemonPid: null,
    authed: false,
    startDaemon: true,
  });
  assert.equal(notice.show, true);
  assert.equal(notice.paneTitle, 'daemon (WAITING FOR SERVER)');
  assert.ok(notice.paneLines.join('\n').toLowerCase().includes('still starting'));
});

test('buildDaemonAuthNotice returns no notice when startDaemon=false', () => {
  const notice = buildDaemonAuthNotice({
    stackName: 'repo-dev-abc123',
    internalServerUrl: 'http://127.0.0.1:53288',
    daemonPid: null,
    authed: false,
    startDaemon: false,
  });
  assert.equal(notice.show, false);
});
