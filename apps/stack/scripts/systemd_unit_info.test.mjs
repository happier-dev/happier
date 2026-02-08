import test from 'node:test';
import assert from 'node:assert/strict';

import * as paths from './utils/paths/paths.mjs';

test('getSystemdUnitInfo returns user-mode unit path and args by default', () => {
  assert.equal(typeof paths.getSystemdUnitInfo, 'function');
  const info = paths.getSystemdUnitInfo();
  assert.equal(typeof info.unitName, 'string');
  assert.equal(typeof info.unitPath, 'string');
  assert.ok(info.unitName.endsWith('.service'));
  assert.ok(info.unitPath.includes('/.config/systemd/user/'));
  assert.deepEqual(info.systemctlArgsPrefix, ['--user']);
  assert.deepEqual(info.journalctlArgsPrefix, ['--user']);
});

test('getSystemdUnitInfo returns system-mode unit path and args', () => {
  assert.equal(typeof paths.getSystemdUnitInfo, 'function');
  const info = paths.getSystemdUnitInfo({ mode: 'system' });
  assert.ok(info.unitName.endsWith('.service'));
  assert.ok(info.unitPath.startsWith('/etc/systemd/system/'));
  assert.deepEqual(info.systemctlArgsPrefix, []);
  assert.deepEqual(info.journalctlArgsPrefix, []);
});
