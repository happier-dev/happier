import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStackContext } from './context.mjs';

test('resolveStackContext expands ~/ explicit env file overrides against HOME', () => {
  const out = resolveStackContext({
    env: {
      HOME: '/scoped/home',
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_ENV_FILE: '~/.happier/stacks/dev/env',
    },
  });

  assert.equal(out.stackMode, true);
  assert.equal(out.stackName, 'dev');
  assert.equal(out.envPath, '/scoped/home/.happier/stacks/dev/env');
});
