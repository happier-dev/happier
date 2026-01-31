import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultStackReviewComponents } from './targets.mjs';

test('resolveDefaultStackReviewComponents returns only non-default pinned components', () => {
  const rootDir = '/tmp/hs-root';
  const keys = [
    'HAPPY_STACKS_WORKSPACE_DIR',
    'HAPPY_STACKS_COMPONENT_DIR_HAPPY',
    'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT',
    'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI',
    'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER',
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.HAPPY_STACKS_WORKSPACE_DIR = '/tmp/hs-root';
    // Default checkouts
    process.env.HAPPY_STACKS_COMPONENT_DIR_HAPPY = '';
    process.env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = '';
    // Pinned overrides
    process.env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = '/tmp/custom/happy-cli';
    process.env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = '/tmp/custom/happy-server';

    const comps = resolveDefaultStackReviewComponents({
      rootDir,
      components: ['happy', 'happy-cli', 'happy-server-light', 'happy-server'],
    });
    assert.deepEqual(comps.sort(), ['happy-cli', 'happy-server'].sort());
  } finally {
    for (const k of keys) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
});

