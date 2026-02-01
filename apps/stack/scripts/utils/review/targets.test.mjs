import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultStackReviewComponents } from './targets.mjs';

test('resolveDefaultStackReviewComponents returns only non-default pinned components', () => {
  const rootDir = '/tmp/hs-root';
  const keys = ['HAPPIER_STACK_WORKSPACE_DIR', 'HAPPIER_STACK_REPO_DIR'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.HAPPIER_STACK_WORKSPACE_DIR = '/tmp/hs-root';
    // Pin the whole monorepo repo dir away from the default.
    process.env.HAPPIER_STACK_REPO_DIR = '/tmp/custom/happier';

    const comps = resolveDefaultStackReviewComponents({
      rootDir,
      components: ['happy', 'happy-cli', 'happy-server-light', 'happy-server'],
    });
    assert.deepEqual(comps.sort(), ['happy', 'happy-cli', 'happy-server-light', 'happy-server'].sort());
  } finally {
    for (const k of keys) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
});
