import test from 'node:test';
import assert from 'node:assert/strict';

import { promptWorktreeSource } from './wizard.mjs';

function mkRl() {
  return { question: async () => '' };
}

test('promptWorktreeSource normalizes create worktree slug and reprompts when it sanitizes to empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  let asks = 0;
  const out = await promptWorktreeSource({
    rl: mkRl(),
    rootDir: '/tmp/hstack-root',
    component: 'happier-ui',
    stackName: 'exp-slug',
    createRemote: 'upstream',
    deps: {
      promptSelect: async () => 'create',
      listWorktreeSpecs: async () => [],
      prompt: async (_rl, question, { defaultValue } = {}) => {
        if (String(question).includes('New worktree slug')) {
          asks += 1;
          return asks === 1 ? '----' : 'My Feature';
        }
        return defaultValue ?? '';
      },
    },
  });

  assert.deepEqual(out, { create: true, slug: 'my-feature', remote: 'upstream' });
});
