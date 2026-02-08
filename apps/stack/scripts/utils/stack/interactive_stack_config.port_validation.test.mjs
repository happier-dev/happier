import test from 'node:test';
import assert from 'node:assert/strict';

import { interactiveEdit, interactiveNew } from './interactive_stack_config.mjs';
import { createInteractiveStackConfigDeps, mkRl } from './interactive_stack_config.test_helper.mjs';

test('interactiveNew reprompts when port input is invalid', async (t) => {
  t.mock.method(console, 'log', () => {});
  const rootDir = '/tmp/hstack-root';
  const rl = mkRl(['not-a-number', '4242']);

  const out = await interactiveNew({
    rootDir,
    rl,
    defaults: {
      stackName: 'exp-port-validate',
      port: null,
      serverComponent: 'happier-server-light',
      createRemote: 'upstream',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps(),
  });

  assert.equal(out.port, 4242);
});

test('interactiveEdit reprompts when port input is invalid and allows empty to keep current port', async (t) => {
  t.mock.method(console, 'log', () => {});
  const rootDir = '/tmp/hstack-root';
  const rl = mkRl([]);

  const prompted = [];
  const out = await interactiveEdit({
    rootDir,
    rl,
    stackName: 'exp-edit-port-validate',
    existingEnv: {
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_STACK_SERVER_PORT: '4101',
      HAPPIER_STACK_STACK_REMOTE: 'upstream',
    },
    defaults: {},
    deps: createInteractiveStackConfigDeps({
      prompt: async (_rl, question, { defaultValue } = {}) => {
        prompted.push(String(question));
        if (String(question).includes('Port')) {
          const idx = prompted.filter((q) => q.includes('Port')).length;
          return idx === 1 ? 'abc' : '';
        }
        return defaultValue ?? '';
      },
    }),
  });

  assert.equal(out.port, 4101);
});

test('interactiveNew accepts explicit "ephemeral" token for unpinned port', async (t) => {
  t.mock.method(console, 'log', () => {});
  const out = await interactiveNew({
    rootDir: '/tmp/hstack-root',
    rl: mkRl(['ephemeral']),
    defaults: {
      stackName: 'exp-port-ephemeral',
      port: null,
      serverComponent: 'happier-server-light',
      createRemote: 'upstream',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps(),
  });
  assert.equal(out.port, null);
});

test('interactiveEdit treats malformed existing port as ephemeral when input is empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  const out = await interactiveEdit({
    rootDir: '/tmp/hstack-root',
    rl: mkRl([]),
    stackName: 'exp-edit-port-malformed',
    existingEnv: {
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_STACK_SERVER_PORT: 'not-a-port',
      HAPPIER_STACK_STACK_REMOTE: 'upstream',
    },
    defaults: {},
    deps: createInteractiveStackConfigDeps({
      prompt: async (_rl, _question, { defaultValue } = {}) => defaultValue ?? '',
    }),
  });
  assert.equal(out.port, null);
});
