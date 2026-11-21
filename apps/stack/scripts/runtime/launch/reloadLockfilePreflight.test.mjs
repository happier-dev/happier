import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { preflightWorkingDependencyInputs } from './reloadLockfilePreflight.mjs';

async function repoWithLockfile(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reload-lockfile-' });
  const repoDir = fixture.path('repo');
  const git = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(repoDir);
  await git('init', '--quiet');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'test');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'lock');
  return { repoDir, git, board: fixture.path('BOARD.md') };
}

// RU2 B.3 (Coordination 2026-11-18 08:52Z): an uncommitted lockfile edit in the shared checkout sent every
// committed-revision reload into the own-lockfile install path instead of the dependency snapshot.
test('a committed-revision reload refuses at once when the working lockfile differs from HEAD, naming the lane', async t => {
  const { repoDir, board } = await repoWithLockfile(t);
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  const { mtimeMs } = await stat(join(repoDir, 'pnpm-lock.yaml'));
  const at = new Date(mtimeMs - 30_000).toISOString().slice(0, 16).replace('T', ' ');
  await writeFile(board, `### ${at} UTC — DEPS-LANE → Systemic — CLAIM — bump zod; pnpm-lock.yaml regenerated\n- body\n`);
  await assert.rejects(preflightWorkingDependencyInputs({ repoDir, overlay: [], boards: [board] }), error => {
    assert.equal(error.code, 'working_lockfile_differs_from_head');
    assert.equal(error.owner, 'DEPS-LANE');
    assert.match(error.message, /DEPS-LANE/);
    return true;
  });
});

test('an unattributed lockfile edit still refuses and says no post names it', async t => {
  const { repoDir, board } = await repoWithLockfile(t);
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  await assert.rejects(preflightWorkingDependencyInputs({ repoDir, overlay: [], boards: [board] }),
    error => error.code === 'working_lockfile_differs_from_head' && error.owner === null);
});

test('a clean lockfile, or one the Stack declares in its overlay, passes', async t => {
  const { repoDir, board } = await repoWithLockfile(t);
  await preflightWorkingDependencyInputs({ repoDir, overlay: [], boards: [board] });
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  await preflightWorkingDependencyInputs({ repoDir, overlay: ['pnpm-lock.yaml'], boards: [board] });
});


test('dirty reload preflight emits wait and rechecks both inputs as workspace bytes and HEAD change', async t => {
  const { repoDir, git } = await repoWithLockfile(t);
  const lock = join(repoDir, 'pnpm-lock.yaml');
  const workspace = join(repoDir, 'pnpm-workspace.yaml');
  await writeFile(lock, 'lockfileVersion: 9.0\nimporters: {}\n');
  await writeFile(workspace, 'packages: [apps/*]\n');
  const waits = [];
  await preflightWorkingDependencyInputs({ repoDir, boards: [], onWait: async wait => {
    waits.push([wait.status, wait.path]);
    if (wait.path === 'pnpm-lock.yaml') {
      await git('add', 'pnpm-lock.yaml');
      await git('commit', '--quiet', '-m', 'update lock');
    } else {
      await writeFile(workspace, 'packages: []\n');
    }
  } });
  assert.deepEqual(waits, [['wait', 'pnpm-lock.yaml'], ['wait', 'pnpm-workspace.yaml']]);
});

test('the dirty preflight prioritizes an explicitly declared overlay and can be superseded', async t => {
  const { repoDir } = await repoWithLockfile(t);
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n');
  await preflightWorkingDependencyInputs({ repoDir, boards: [], overlay: ['pnpm-workspace.yaml'],
    onWait: () => assert.fail('declared overlay must not block this request') });
  const cancellation = new AbortController();
  const reason = new Error('new reload superseded this request');
  await assert.rejects(preflightWorkingDependencyInputs({ repoDir, boards: [], signal: cancellation.signal,
    onWait: () => cancellation.abort(reason) }), reason);
});
