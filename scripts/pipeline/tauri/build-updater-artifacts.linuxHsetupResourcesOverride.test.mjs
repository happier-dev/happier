import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLinuxHsetupResourcesOverrideConfig } from './build-updater-artifacts.mjs';

test('resolveLinuxHsetupResourcesOverrideConfig moves hsetup out of externalBin and into bundle resources', () => {
  assert.deepEqual(resolveLinuxHsetupResourcesOverrideConfig(), {
    bundle: {
      externalBin: [],
      resources: ['binaries/hsetup-*'],
    },
  });
});

