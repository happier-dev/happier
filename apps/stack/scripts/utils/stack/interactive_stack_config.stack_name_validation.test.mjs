import test from 'node:test';
import assert from 'node:assert/strict';

import { interactiveNew } from './interactive_stack_config.mjs';
import { createInteractiveStackConfigDeps, mkRl } from './interactive_stack_config.test_helper.mjs';

test('interactiveNew normalizes stackName to a DNS-safe label', async (t) => {
  t.mock.method(console, 'log', () => {});
  const out = await interactiveNew({
    rootDir: '/tmp/hstack-root',
    rl: mkRl(['My Stack']),
    defaults: {
      stackName: '',
      port: 4101,
      serverComponent: 'happier-server-light',
      createRemote: 'upstream',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps(),
  });
  assert.equal(out.stackName, 'my-stack');
});

test('interactiveNew reprompts when stackName is reserved or sanitizes to empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  const out = await interactiveNew({
    rootDir: '/tmp/hstack-root',
    rl: mkRl(['main', '----', 'ok-stack']),
    defaults: {
      stackName: '',
      port: 4101,
      serverComponent: 'happier-server-light',
      createRemote: 'upstream',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps(),
  });
  assert.equal(out.stackName, 'ok-stack');
});

test('interactiveNew rejects prefilled reserved stackName', async (t) => {
  t.mock.method(console, 'log', () => {});
  await assert.rejects(
    () =>
      interactiveNew({
        rootDir: '/tmp/hstack-root',
        rl: mkRl([]),
        defaults: {
          stackName: 'main',
          port: 4101,
          serverComponent: 'happier-server-light',
          createRemote: 'upstream',
          repo: 'default',
        },
        deps: createInteractiveStackConfigDeps(),
      }),
    /reserved/i
  );
});

test('interactiveNew reprompts when stackName exceeds max length', async (t) => {
  t.mock.method(console, 'log', () => {});
  const out = await interactiveNew({
    rootDir: '/tmp/hstack-root',
    rl: mkRl(['a'.repeat(64), 'max-len-ok']),
    defaults: {
      stackName: '',
      port: 4101,
      serverComponent: 'happier-server-light',
      createRemote: 'upstream',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps(),
  });
  assert.equal(out.stackName, 'max-len-ok');
});
