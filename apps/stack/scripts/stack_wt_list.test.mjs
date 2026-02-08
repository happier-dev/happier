import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './stack_script_cmd.testHelper.mjs';

async function touchWorktree(dir) {
  await mkdir(dir, { recursive: true });
  // In a git worktree, ".git" is often a file; our detection treats either file or dir as truthy.
  await writeFile(join(dir, '.git'), 'gitdir: /dev/null\n', 'utf-8');
}

async function setupStackWtListFixture({ importMetaUrl, t, tmpPrefix }) {
  const scriptsDir = dirname(fileURLToPath(importMetaUrl));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix));

  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const stackName = 'exp-test';

  const wtRoot = join(workspaceDir, 'pr');
  const monoActive = join(wtRoot, 'active-branch');
  const monoOther = join(wtRoot, 'other-branch');
  await touchWorktree(monoActive);
  await touchWorktree(monoOther);

  for (const monorepoRoot of [monoActive, monoOther]) {
    await mkdir(join(monorepoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monorepoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monorepoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monorepoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monorepoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  }

  const envDir = join(storageDir, stackName);
  const envPath = join(envDir, 'env');
  await mkdir(envDir, { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${monoActive}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    // Prevent loading the user's real ~/.happier-stack/.env via canonical discovery.
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  async function runStackWtList(extraArgs = []) {
    return await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'wt', stackName, '--', 'list', ...extraArgs], {
      cwd: rootDir,
      env: baseEnv,
    });
  }

  return {
    monoActive,
    monoOther,
    runStackWtList,
  };
}

test('hstack stack wt <stack> -- list defaults to active-only (no exhaustive enumeration)', async (t) => {
  const fixture = await setupStackWtListFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happy-stacks-stack-wt-list-',
  });

  const res = await fixture.runStackWtList();
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(
    res.stdout.includes(`- active: ${fixture.monoActive}`),
    `expected happy active in output\n${res.stdout}`
  );

  // Should NOT enumerate other worktrees unless --all was passed.
  assert.ok(!res.stdout.includes(`- ${fixture.monoOther}`), `expected other to be omitted\n${res.stdout}`);
});

test('hstack stack wt <stack> -- list --all shows all worktrees (opt-in)', async (t) => {
  const fixture = await setupStackWtListFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happy-stacks-stack-wt-list-all-',
  });

  const res = await fixture.runStackWtList(['--all']);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(
    res.stdout.includes(`- active: ${fixture.monoActive}`),
    `expected happy active in output\n${res.stdout}`
  );
  assert.ok(
    res.stdout.includes(`- ${fixture.monoOther}`),
    `expected happy other to be listed with --all\n${res.stdout}`
  );
});
