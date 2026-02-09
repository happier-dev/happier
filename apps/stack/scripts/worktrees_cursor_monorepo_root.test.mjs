import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMonorepoWorktreeEnv, createMonorepoWorktreeFixture, runNode } from './testkit/worktrees_monorepo_testkit.mjs';

test('hstack wt cursor opens the monorepo root (not a subpackage dir) in monorepo worktrees', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { homeDir, monoRoot, sandboxDir, workspaceDir } = await createMonorepoWorktreeFixture(t, {
    prefix: 'happy-stacks-wt-cursor-mono-',
  });
  const env = createMonorepoWorktreeEnv({ homeDir, workspaceDir, sandboxDir });

  const res = await runNode([join(rootDir, 'scripts', 'worktrees.mjs'), 'cursor', 'tmp/mono-wt', '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.dir, monoRoot);
});
