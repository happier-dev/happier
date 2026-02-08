import test from 'node:test';
import assert from 'node:assert/strict';

import { interactiveEdit, interactiveNew } from './interactive_stack_config.mjs';
import { createInteractiveStackConfigDeps, mkRl } from './interactive_stack_config.test_helper.mjs';

test('interactiveNew reprompts when createRemote input is invalid', async (t) => {
  t.mock.method(console, 'log', () => {});
  const asked = [];
  let remoteAnswers = 0;
  const out = await interactiveNew({
    rootDir: '/tmp/hstack-root',
    rl: mkRl([]),
    defaults: {
      stackName: 'exp-remote-validate',
      port: 4101,
      serverComponent: 'happier-server-light',
      createRemote: '',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps({
      prompt: async (_rl, question, { defaultValue } = {}) => {
        asked.push(String(question));
        if (String(question).includes('Git remote for new worktrees')) {
          remoteAnswers += 1;
          return remoteAnswers === 1 ? 'bad remote' : 'upstream';
        }
        return defaultValue ?? '';
      },
    }),
  });

  assert.ok(asked.some((q) => q.includes('Git remote for new worktrees')));
  assert.equal(out.createRemote, 'upstream');
});

test('interactiveEdit reprompts when createRemote input is invalid', async (t) => {
  t.mock.method(console, 'log', () => {});
  let remoteAnswers = 0;
  const out = await interactiveEdit({
    rootDir: '/tmp/hstack-root',
    rl: mkRl([]),
    stackName: 'exp-edit-remote-validate',
    existingEnv: {
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_STACK_SERVER_PORT: '4101',
      HAPPIER_STACK_STACK_REMOTE: 'origin',
    },
    defaults: {},
    deps: createInteractiveStackConfigDeps({
      prompt: async (_rl, question, { defaultValue } = {}) => {
        if (String(question).includes('Git remote for new worktrees')) {
          remoteAnswers += 1;
          return remoteAnswers === 1 ? 'bad remote' : 'upstream';
        }
        if (String(question).includes('Port')) {
          return '';
        }
        return defaultValue ?? '';
      },
    }),
  });

  assert.equal(out.createRemote, 'upstream');
});

test('interactiveEdit keeps current remote when prompt answer is empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  const out = await interactiveEdit({
    rootDir: '/tmp/hstack-root',
    rl: mkRl([]),
    stackName: 'exp-edit-remote-default',
    existingEnv: {
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_STACK_SERVER_PORT: '4101',
      HAPPIER_STACK_STACK_REMOTE: 'origin',
    },
    defaults: {},
    deps: createInteractiveStackConfigDeps({
      prompt: async (_rl, question, { defaultValue } = {}) => {
        if (String(question).includes('Git remote for new worktrees')) {
          return '';
        }
        if (String(question).includes('Port')) {
          return '';
        }
        return defaultValue ?? '';
      },
    }),
  });

  assert.equal(out.createRemote, 'origin');
});

test('interactiveNew accepts slash in createRemote input', async (t) => {
  t.mock.method(console, 'log', () => {});
  let remoteAnswers = 0;
  const out = await interactiveNew({
    rootDir: '/tmp/hstack-root',
    rl: mkRl([]),
    defaults: {
      stackName: 'exp-remote-slash',
      port: 4101,
      serverComponent: 'happier-server-light',
      createRemote: '',
      repo: 'default',
    },
    deps: createInteractiveStackConfigDeps({
      prompt: async (_rl, question, { defaultValue } = {}) => {
        if (String(question).includes('Git remote for new worktrees')) {
          remoteAnswers += 1;
          if (remoteAnswers > 1) throw new Error('unexpected remote reprompt');
          return 'team/upstream';
        }
        return defaultValue ?? '';
      },
    }),
  });

  assert.equal(remoteAnswers, 1);
  assert.equal(out.createRemote, 'team/upstream');
});
