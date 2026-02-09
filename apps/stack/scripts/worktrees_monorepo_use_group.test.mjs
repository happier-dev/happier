import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMonorepoWorktreeEnv, createMonorepoWorktreeFixture, runNode } from './testkit/worktrees_monorepo_testkit.mjs';

test('hstack wt use switches all monorepo group components when target is a monorepo worktree', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { homeDir, monoRoot, sandboxDir, tmp, workspaceDir } = await createMonorepoWorktreeFixture(t, {
    prefix: 'happy-stacks-wt-use-mono-',
  });
  const envFile = join(tmp, 'env');
  await writeFile(envFile, '', 'utf-8');

  const env = createMonorepoWorktreeEnv({
    homeDir,
    workspaceDir,
    sandboxDir,
    extraEnv: {
      HAPPIER_STACK_STACK: 'exp',
      HAPPIER_STACK_ENV_FILE: envFile,
    },
  });

  const res = await runNode(
    [join(rootDir, 'scripts', 'worktrees.mjs'), 'use', 'tmp/mono-wt', '--force', '--json'],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.repoDir, monoRoot);
  assert.equal(parsed.activeDir, monoRoot);

  const contents = await readFile(envFile, 'utf-8');
  assert.ok(contents.includes(`HAPPIER_STACK_REPO_DIR=${monoRoot}\n`), contents);
  assert.ok(!contents.includes('HAPPIER_STACK_COMPONENT_DIR_'), contents);
});
