import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { promptWorktreeSource } from './wizard.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-wizard-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

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
    component: 'happier-ui',
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
    component: 'happier-ui',
    stackName: 'exp1',
    createRemote: 'upstream',
    deps: { listWorktreeSpecs, promptSelect, prompt },
  });

  assert.equal(res, 'pr/456');
  assert.equal(listed, 1);
});

test('promptWorktreeSource falls back to default when pick has no available repos', async (t) => {
  const workspaceDir = await withTempRoot(t);
  let selectCount = 0;
  const res = await promptWorktreeSource({
    rl: {},
    rootDir: '/tmp',
    component: 'happier-ui',
    stackName: 'exp1',
    createRemote: 'upstream',
    env: { ...process.env, HAPPIER_STACK_WORKSPACE_DIR: workspaceDir },
    deps: {
      listWorktreeSpecs: async () => [],
      promptSelect: async (_rl, { title }) => {
        selectCount += 1;
        if (selectCount === 1) {
          assert.ok(title.startsWith('Select '));
          return 'pick';
        }
        throw new Error('unexpected second selection when no repos are available');
      },
      prompt: async () => '',
    },
  });

  assert.equal(res, 'default');
  assert.equal(selectCount, 1);
});

test('promptWorktreeSource offers dev when dev checkout exists (even with no category worktrees)', async (t) => {
  const workspaceDir = await withTempRoot(t);
  await mkdir(join(workspaceDir, 'dev'), { recursive: true });
  const devGitFile = join(workspaceDir, 'dev', '.git');
  await writeFile(devGitFile, 'gitdir: /tmp/fake', { encoding: 'utf8' });

  const listWorktreeSpecs = async () => [];

  let selectCount = 0;
  const promptSelect = async (_rl, { title, options }) => {
    selectCount++;
    if (selectCount === 1) {
      assert.ok(title.startsWith('Select '));
      return 'pick';
    }
    assert.ok(title.startsWith('Available '));
    assert.ok(options.some((o) => o.value === 'dev'));
    return 'dev';
  };
  const prompt = async () => '';

  const res = await promptWorktreeSource({
    rl: {},
    rootDir: '/tmp',
    component: 'happier-ui',
    stackName: 'exp1',
    createRemote: 'upstream',
    env: { ...process.env, HAPPIER_STACK_WORKSPACE_DIR: workspaceDir },
    deps: { listWorktreeSpecs, promptSelect, prompt },
  });

  assert.equal(res, 'dev');
});
