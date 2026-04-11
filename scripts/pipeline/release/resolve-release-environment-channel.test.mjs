import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReleaseEnvironmentChannel } from './resolve-release-environment-channel.mjs';

test('resolveReleaseEnvironmentChannel maps dev releases to the public dev ring', () => {
  assert.deepEqual(resolveReleaseEnvironmentChannel('dev'), {
    channel: 'publicdev',
    publicChannelArg: 'dev',
    npmChannelArg: 'dev',
    sourceRef: 'dev',
    dockerChannelArg: 'dev',
    allowStable: 'false',
    rollingVersionPrefix: 'dev',
  });
});

test('resolveReleaseEnvironmentChannel maps preview and production release rings', () => {
  assert.deepEqual(resolveReleaseEnvironmentChannel('preview'), {
    channel: 'preview',
    publicChannelArg: 'preview',
    npmChannelArg: 'preview',
    sourceRef: 'preview',
    dockerChannelArg: 'preview',
    allowStable: 'false',
    rollingVersionPrefix: 'preview',
  });

  assert.deepEqual(resolveReleaseEnvironmentChannel('production'), {
    channel: 'stable',
    publicChannelArg: 'stable',
    npmChannelArg: 'production',
    sourceRef: 'main',
    dockerChannelArg: 'stable',
    allowStable: 'true',
    rollingVersionPrefix: '',
  });
});
