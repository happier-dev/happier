import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePluginsDevPlatform } from './pluginsDevPlatform';

test('normalizes supported runtime platforms into truthful evidence labels', () => {
  assert.deepEqual(resolvePluginsDevPlatform('darwin'), {
    runtimePlatform: 'darwin',
    evidencePlatform: 'macos',
    scenario: 'plugins-dev-macos-live',
    runLabel: 'plugins-dev-macos',
    qaLabel: 'QA-005-macos',
  });
  assert.deepEqual(resolvePluginsDevPlatform('linux'), {
    runtimePlatform: 'linux',
    evidencePlatform: 'linux',
    scenario: 'plugins-dev-linux-live',
    runLabel: 'plugins-dev-linux',
    qaLabel: 'QA-005-linux',
  });
  assert.deepEqual(resolvePluginsDevPlatform('win32'), {
    runtimePlatform: 'win32',
    evidencePlatform: 'windows',
    scenario: 'plugins-dev-windows-live',
    runLabel: 'plugins-dev-windows',
    qaLabel: 'QA-005-windows',
  });
});

test('rejects runtime platforms outside the QA-005 desktop matrix', () => {
  assert.throws(
    () => resolvePluginsDevPlatform('aix'),
    /supports only darwin, linux, and win32; current platform is aix/u,
  );
});
