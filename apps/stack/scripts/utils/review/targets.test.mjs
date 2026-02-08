import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultStackReviewComponents } from './targets.mjs';

test('resolveDefaultStackReviewComponents returns only non-default pinned components', () => {
  const rootDir = '/tmp/hs-root';
  const env = {
    HAPPIER_STACK_WORKSPACE_DIR: '/tmp/hs-root',
    HAPPIER_STACK_REPO_DIR: '/tmp/custom/happier',
  };
  const comps = resolveDefaultStackReviewComponents({
    rootDir,
    env,
    components: ['happy', 'happy-cli', 'happy-server-light', 'happy-server'],
  });
  assert.deepEqual(comps.sort(), ['happy', 'happy-cli', 'happy-server-light', 'happy-server'].sort());
});

test('resolveDefaultStackReviewComponents returns empty list for default repo checkout', () => {
  const rootDir = '/tmp/hs-root';
  const env = {
    HAPPIER_STACK_WORKSPACE_DIR: '/tmp/hs-root',
    HAPPIER_STACK_REPO_DIR: '',
  };
  const comps = resolveDefaultStackReviewComponents({
    rootDir,
    env,
    components: ['happy', 'happy-cli'],
  });
  assert.deepEqual(comps, []);
});
