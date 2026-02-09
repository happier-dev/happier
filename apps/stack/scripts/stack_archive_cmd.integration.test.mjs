import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';
import { createStackArchiveFixture } from './testkit/stack_archive_command_testkit.mjs';

test('hstack stack archive moves the stack and archives its referenced worktrees', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const fixture = await createStackArchiveFixture(t, { stackName: 'exp-test', worktreeSlug: 'archived-by-stack' });

  const date = '2000-01-04';
  const nodeEnv = { ...fixture.baseEnv, PATH: '' };
  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'archive', fixture.stackName, `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected stack archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);

  const archivedStackDir = join(fixture.storageDir, '.archived', date, fixture.stackName);
  assert.equal(parsed.archivedStackDir, archivedStackDir, `expected archivedStackDir in JSON output\n${res.stdout}`);
  await stat(join(archivedStackDir, 'env'));

  const archivedWorktreeDir = join(fixture.workspaceDir, 'archive', 'worktrees', date, 'pr', 'archived-by-stack');
  const gitStat = await stat(join(archivedWorktreeDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived worktree to be detached (standalone .git dir)');
});
