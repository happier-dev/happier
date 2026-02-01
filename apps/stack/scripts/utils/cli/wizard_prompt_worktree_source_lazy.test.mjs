import test from 'node:test';
import assert from 'node:assert/strict';

import { promptWorktreeSource } from './wizard.mjs';

test('promptWorktreeSource does not list worktrees unless user selects "pick"', async () => {
  let listed = 0;
  const listWorktreeSpecs = async () => {
    listed++;
    return ['pr/123'];
  };

  const promptSelect = async () => 'default';
  const prompt = async () => '';

  const res = await promptWorktreeSource({
    rl: {},
    rootDir: '/tmp',
    component: 'happy',
    stackName: 'exp1',
    createRemote: 'upstream',
    deps: { listWorktreeSpecs, promptSelect, prompt },
  });

  assert.equal(res, 'default');
  assert.equal(listed, 0);
});

test('promptWorktreeSource lists worktrees when user selects "pick"', async () => {
  let listed = 0;
  const listWorktreeSpecs = async () => {
    listed++;
    return ['pr/123', 'pr/456'];
  };

  let selectCount = 0;
  const promptSelect = async (_rl, { title }) => {
    selectCount++;
    if (selectCount === 1) {
      assert.ok(title.startsWith('Select '));
      return 'pick';
    }
    assert.ok(title.startsWith('Available '));
    return 'pr/456';
  };
  const prompt = async () => '';

  const res = await promptWorktreeSource({
    rl: {},
    rootDir: '/tmp',
    component: 'happy',
    stackName: 'exp1',
    createRemote: 'upstream',
    deps: { listWorktreeSpecs, promptSelect, prompt },
  });

  assert.equal(res, 'pr/456');
  assert.equal(listed, 1);
});
