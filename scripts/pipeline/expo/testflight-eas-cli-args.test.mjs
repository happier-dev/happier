import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEasBuildViewArgs } from './testflight-eas-cli-args.mjs';

test('buildEasBuildViewArgs pins the default EAS CLI version', () => {
  assert.deepEqual(buildEasBuildViewArgs({ easBuildId: 'build-id' }), [
    '--yes',
    'eas-cli@18.0.1',
    'build:view',
    'build-id',
    '--json',
  ]);
});

test('buildEasBuildViewArgs respects an explicit EAS CLI version', () => {
  assert.deepEqual(buildEasBuildViewArgs({ easBuildId: 'build-id', easCliVersion: '19.2.0' }), [
    '--yes',
    'eas-cli@19.2.0',
    'build:view',
    'build-id',
    '--json',
  ]);
});
