import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUserConfigEnvPath } from './config.mjs';

test('resolveUserConfigEnvPath expands ~/ explicit stack env file overrides against HOME', () => {
  const originalHome = process.env.HOME;
  const originalEnvFile = process.env.HAPPIER_STACK_ENV_FILE;

  process.env.HOME = '/scoped/home';
  process.env.HAPPIER_STACK_ENV_FILE = '~/.happier/stacks/dev/env';

  try {
    assert.equal(
      resolveUserConfigEnvPath({ cliRootDir: '/unused' }),
      '/scoped/home/.happier/stacks/dev/env',
    );
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalEnvFile == null) {
      delete process.env.HAPPIER_STACK_ENV_FILE;
    } else {
      process.env.HAPPIER_STACK_ENV_FILE = originalEnvFile;
    }
  }
});
