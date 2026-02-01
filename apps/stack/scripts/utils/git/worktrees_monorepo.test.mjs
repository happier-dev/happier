import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { worktreeSpecFromDir } from './worktrees.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-worktrees-monorepo-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeHappyMonorepoStub({ rootDir, worktreeRoot }) {
  void rootDir;
  // Stub a monorepo worktree root (apps/* markers + .git) for spec parsing.
  await mkdir(join(worktreeRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(worktreeRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(worktreeRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(worktreeRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');
}

test('worktreeSpecFromDir normalizes monorepo package dirs to the worktree spec', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const wtRoot = join(rootDir, 'pr', '123-fix-monorepo');
  await mkdir(wtRoot, { recursive: true });
  await writeHappyMonorepoStub({ rootDir, worktreeRoot: wtRoot });

  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happy', dir: join(wtRoot, 'apps', 'ui'), env }),
    'pr/123-fix-monorepo'
  );
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happy-cli', dir: join(wtRoot, 'apps', 'cli'), env }),
    'pr/123-fix-monorepo'
  );
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happy-server', dir: join(wtRoot, 'apps', 'server'), env }),
    'pr/123-fix-monorepo'
  );
});
