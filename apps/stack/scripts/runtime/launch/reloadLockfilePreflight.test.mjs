import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { refuseWorkingLockfileDrift } from './reloadLockfilePreflight.mjs';

async function repoWithLockfile(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reload-lockfile-' });
  const repoDir = fixture.path('repo');
  const git = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(repoDir);
  await git('init', '--quiet');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'test');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'lock');
  return { repoDir, board: fixture.path('BOARD.md') };
}

// RU2 B.3 (Coordination 2026-11-18 08:52Z): an uncommitted lockfile edit in the shared checkout sent every
// committed-revision reload into the own-lockfile install path instead of the dependency snapshot.
test('a committed-revision reload refuses at once when the working lockfile differs from HEAD, naming the lane', async t => {
  const { repoDir, board } = await repoWithLockfile(t);
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  const { mtimeMs } = await stat(join(repoDir, 'pnpm-lock.yaml'));
  const at = new Date(mtimeMs - 30_000).toISOString().slice(0, 16).replace('T', ' ');
  await writeFile(board, `### ${at} UTC — DEPS-LANE → Systemic — CLAIM — bump zod; pnpm-lock.yaml regenerated\n- body\n`);
  await assert.rejects(refuseWorkingLockfileDrift({ repoDir, overlay: [], boards: [board] }), error => {
    assert.equal(error.code, 'working_lockfile_differs_from_head');
    assert.equal(error.owner, 'DEPS-LANE');
    assert.match(error.message, /DEPS-LANE/);
    return true;
  });
});

test('an unattributed lockfile edit still refuses and says no post names it', async t => {
  const { repoDir, board } = await repoWithLockfile(t);
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  await assert.rejects(refuseWorkingLockfileDrift({ repoDir, overlay: [], boards: [board] }),
    error => error.code === 'working_lockfile_differs_from_head' && error.owner === null);
});

test('a clean lockfile, or one the Stack declares in its overlay, passes', async t => {
  const { repoDir, board } = await repoWithLockfile(t);
  await refuseWorkingLockfileDrift({ repoDir, overlay: [], boards: [board] });
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  await refuseWorkingLockfileDrift({ repoDir, overlay: ['pnpm-lock.yaml'], boards: [board] });
});
