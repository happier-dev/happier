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
  const monoRoot = join(rootDir, 'components', 'happy');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  // Also stub a monorepo worktree root (same structure) for spec parsing.
  await mkdir(join(worktreeRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(worktreeRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(worktreeRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(worktreeRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');
  return { monoRoot };
}

test('worktreeSpecFromDir normalizes monorepo package dirs to the worktree spec', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const wtRoot = join(rootDir, '.worktrees', 'slopus', 'pr', '123-fix-monorepo');
  await mkdir(wtRoot, { recursive: true });
  await writeHappyMonorepoStub({ rootDir, worktreeRoot: wtRoot });

  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happy', dir: join(wtRoot, 'apps', 'ui'), env }),
    'slopus/pr/123-fix-monorepo'
  );
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happy-cli', dir: join(wtRoot, 'apps', 'cli'), env }),
    'slopus/pr/123-fix-monorepo'
  );
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happy-server', dir: join(wtRoot, 'apps', 'server'), env }),
    'slopus/pr/123-fix-monorepo'
  );
});
