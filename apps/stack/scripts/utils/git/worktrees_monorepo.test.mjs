import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { worktreeSpecFromDir } from './worktrees.mjs';

async function writeHappyMonorepoStub({ rootDir, worktreeRoot }) {
  void rootDir;
  // Stub a monorepo worktree root (apps/* markers + .git) for spec parsing.
  await ensureMinimalMonorepoLayout(worktreeRoot, { writeGitDirMarker: true });
}

test('worktreeSpecFromDir normalizes monorepo package dirs to the worktree spec', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stack-worktrees-monorepo-' });
  const rootDir = fixture.root;
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const wtRoot = join(rootDir, 'pr', '123-fix-monorepo');
  await mkdir(wtRoot, { recursive: true });
  await writeHappyMonorepoStub({ rootDir, worktreeRoot: wtRoot });

  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: join(wtRoot, 'apps', 'ui'), env }),
    'pr/123-fix-monorepo'
  );
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happier-cli', dir: join(wtRoot, 'apps', 'cli'), env }),
    'pr/123-fix-monorepo'
  );
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happier-server', dir: join(wtRoot, 'apps', 'server'), env }),
    'pr/123-fix-monorepo'
  );
});

test('worktreeSpecFromDir resolves the same spec from the monorepo root and nested unknown dirs', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stack-worktrees-monorepo-' });
  const rootDir = fixture.root;
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };
  const wtRoot = join(rootDir, 'pr', '456-pathstyle');
  await mkdir(join(wtRoot, 'docs', 'guides'), { recursive: true });
  await writeHappyMonorepoStub({ rootDir, worktreeRoot: wtRoot });

  assert.equal(worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: wtRoot, env }), 'pr/456-pathstyle');
  assert.equal(
    worktreeSpecFromDir({ rootDir, component: 'happier-cli', dir: join(wtRoot, 'docs', 'guides'), env }),
    'pr/456-pathstyle'
  );
});
