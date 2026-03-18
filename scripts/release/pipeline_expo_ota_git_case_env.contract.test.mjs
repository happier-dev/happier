import test from 'node:test';
import assert from 'node:assert/strict';

import { withEasGitCaseSensitiveEnv } from '../pipeline/expo/eas-git-case-sensitive-env.mjs';

test('EAS git env helper returns a stable env object', () => {
  const env = withEasGitCaseSensitiveEnv({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.ignorecase',
    GIT_CONFIG_VALUE_0: 'true',
  });

  assert.equal(typeof env, 'object');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.ignorecase');
});
