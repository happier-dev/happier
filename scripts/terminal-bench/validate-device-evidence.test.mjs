import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';

import { resolveDeviceEvidenceCliArgs } from './validate-device-evidence.mjs';
import { resolveNativeAppPackageArgs } from './inspect-native-app-package.mjs';

test('device evidence wrapper resolves caller-relative evidence before changing package cwd', () => {
  const callerCwd = '/repo';
  assert.deepEqual(
    resolveDeviceEvidenceCliArgs([
      '--device-acceptance',
      'packages/tests/.project/logs/e2e/terminal-native/ios/run/evidence.json',
    ], callerCwd),
    [
      '--device-acceptance',
      resolve(callerCwd, 'packages/tests/.project/logs/e2e/terminal-native/ios/run/evidence.json'),
    ],
  );
});

test('device evidence wrapper preserves an absolute evidence path', () => {
  const evidencePath = resolve('/repo/packages/tests/.project/logs/e2e/terminal-native/ios/run/evidence.json');
  assert.deepEqual(resolveDeviceEvidenceCliArgs([evidencePath], '/different-cwd'), [evidencePath]);
});

test('native package wrapper preserves enums and resolves every caller-relative tool/artifact path', () => {
  const callerCwd = '/repo';
  assert.deepEqual(resolveNativeAppPackageArgs([
    '--platform', 'android', '--binary', 'build/app.apk', '--output', 'run/package.json',
    '--aapt2', 'sdk/aapt2', '--apksigner', '/sdk/apksigner',
  ], callerCwd), [
    '--platform', 'android', '--binary', resolve(callerCwd, 'build/app.apk'),
    '--output', resolve(callerCwd, 'run/package.json'), '--aapt2', resolve(callerCwd, 'sdk/aapt2'),
    '--apksigner', '/sdk/apksigner',
  ]);
  assert.deepEqual(resolveNativeAppPackageArgs([
    '--platform', 'ios', '--binary', 'build/app.zip', '--output', 'run/package.json',
    '--ios-signing-mode', 'simulator-unsigned',
  ], callerCwd), [
    '--platform', 'ios', '--binary', resolve(callerCwd, 'build/app.zip'),
    '--output', resolve(callerCwd, 'run/package.json'), '--ios-signing-mode', 'simulator-unsigned',
  ]);
});
