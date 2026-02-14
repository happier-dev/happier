import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveServiceBackend } from './service_manager.mjs';

test('resolveServiceBackend selects launchd for darwin', () => {
  assert.equal(resolveServiceBackend({ platform: 'darwin', mode: 'user' }), 'launchd-user');
  assert.equal(resolveServiceBackend({ platform: 'darwin', mode: 'system' }), 'launchd-system');
});

test('resolveServiceBackend selects systemd for linux', () => {
  assert.equal(resolveServiceBackend({ platform: 'linux', mode: 'user' }), 'systemd-user');
  assert.equal(resolveServiceBackend({ platform: 'linux', mode: 'system' }), 'systemd-system');
});

test('resolveServiceBackend selects schtasks for windows', () => {
  assert.equal(resolveServiceBackend({ platform: 'win32', mode: 'user' }), 'schtasks-user');
  assert.equal(resolveServiceBackend({ platform: 'win32', mode: 'system' }), 'schtasks-system');
});

