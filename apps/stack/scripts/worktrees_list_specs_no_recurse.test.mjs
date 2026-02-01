import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listWorktreeSpecs } from './utils/git/worktrees.mjs';

test('listWorktreeSpecs does not recurse into worktree roots', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-list-wt-specs-'));
  try {
    const workspaceDir = join(tmp, 'workspace');
    const env = { ...process.env, HAPPIER_STACK_WORKSPACE_DIR: workspaceDir, HAPPIER_STACK_OWNER: 'test' };
    const rootDir = tmp;

    const wtRoot = join(workspaceDir, 'tmp', 'test', 'mono-wt');
    await mkdir(wtRoot, { recursive: true });
    await writeFile(join(wtRoot, '.git'), 'gitdir: dummy\n', 'utf-8');

    // If listWorktreeSpecs incorrectly recurses into worktree roots, it would discover this nested ".git"
    // and return an extra spec.
    const nested = join(wtRoot, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, '.git'), 'gitdir: dummy\n', 'utf-8');

    const specs = await listWorktreeSpecs({ rootDir, component: 'happy', env });
    assert.ok(specs.includes('tmp/mono-wt'), specs.join('\n'));
    assert.ok(!specs.includes('tmp/mono-wt/nested'), specs.join('\n'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
