import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { readQaGreen, resolveQaGreenStateDir, runQaGreenPass } from './qa_green.mjs';
import { selectReloadSourceRevision } from '../runtime/launch/prepareSourceRuntimeReload.mjs';

async function gitRepo(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-qa-green-' });
  const repoDir = fixture.path('repo');
  const git = async (...args) => (await promisify(execFile)('git', ['-C', repoDir, ...args])).stdout.trim();
  await mkdir(repoDir);
  await git('init', '--quiet');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'test');
  const commit = async name => {
    await writeFile(join(repoDir, 'file.txt'), name);
    await git('add', '-A');
    await git('commit', '--quiet', '-m', name);
    return await git('rev-parse', 'HEAD');
  };
  return { repoDir, stateDir: fixture.path('qa-green'), commit };
}

test('a READY check of HEAD makes it green; the same HEAD is never checked twice', async t => {
  const { repoDir, stateDir, commit } = await gitRepo(t);
  const head = await commit('one');
  const checked = [];
  const check = async revision => { checked.push(revision); return { status: 'READY', durationMs: 5 }; };
  assert.equal(await readQaGreen({ stateDir }), null);
  await runQaGreenPass({ repoDir, stateDir, check });
  await runQaGreenPass({ repoDir, stateDir, check });
  assert.deepEqual(checked, [head]);
  assert.equal((await readQaGreen({ stateDir })).revision, head);
});

test('a NOT_READY HEAD keeps the previous green and is recorded with the failing check', async t => {
  const { repoDir, stateDir, commit } = await gitRepo(t);
  const good = await commit('good');
  await runQaGreenPass({ repoDir, stateDir, check: async () => ({ status: 'READY', durationMs: 1 }) });
  const bad = await commit('bad');
  await runQaGreenPass({ repoDir, stateDir, check: async () => ({ status: 'NOT_READY', check: 'agent', durationMs: 1 }) });
  assert.equal((await readQaGreen({ stateDir })).revision, good);
  const log = await readFile(join(stateDir, 'checks.log'), 'utf8');
  assert.match(log, new RegExp(`NOT_READY rev=${bad} check=agent`));
  // A failed HEAD is checked once; only a newer HEAD is checked again.
  let calls = 0;
  await runQaGreenPass({ repoDir, stateDir, check: async () => { calls += 1; return { status: 'READY' }; } });
  assert.equal(calls, 0);
});

test('green never moves to a revision that is not a descendant of the current green', async t => {
  const { repoDir, stateDir, commit } = await gitRepo(t);
  const first = await commit('first');
  const second = await commit('second');
  await runQaGreenPass({ repoDir, stateDir, check: async () => ({ status: 'READY' }) });
  assert.equal((await readQaGreen({ stateDir })).revision, second);
  // An older revision (a rewound HEAD) proven READY later does not move green backwards.
  await promisify(execFile)('git', ['-C', repoDir, 'update-ref', 'HEAD', first]);
  await runQaGreenPass({ repoDir, stateDir, check: async () => ({ status: 'READY' }) });
  assert.equal((await readQaGreen({ stateDir })).revision, second);
});

test('a plain QA reload selects the green commit; --rev and overlays keep their meaning', () => {
  const green = { revision: 'a'.repeat(40) };
  assert.equal(selectReloadSourceRevision({ green, overlay: [] }), green.revision);
  assert.equal(selectReloadSourceRevision({ rev: 'HEAD', green, overlay: [] }), 'HEAD');
  // An overlay is a lane's uncommitted edit written against HEAD.
  assert.equal(selectReloadSourceRevision({ green, overlay: ['apps/cli/src/a.ts'] }), 'HEAD');
  assert.equal(selectReloadSourceRevision({ green: null, overlay: [], latestBuilt: 'b'.repeat(40) }), 'b'.repeat(40));
  assert.equal(selectReloadSourceRevision({ green: null, overlay: [] }), 'HEAD');
});

test('a corrupt green record reads as absent, never as a revision', async t => {
  const { stateDir } = await gitRepo(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'green.json'), '{"revision":"not-a-sha"}');
  assert.equal(await readQaGreen({ stateDir }), null);
});

// 2026-11-18 09:50Z: commits from a session whose env selected another stack (a 0.2 repo-remote-dev
// authority) kicked the check into a second state dir, so two pointers and two concurrent bed reloads existed.
test('the green state belongs to the repository, whatever stack the committer\'s env selects', async t => {
  const { repoDir } = await gitRepo(t);
  const storage = join(repoDir, '..', 'stacks');
  const plain = await resolveQaGreenStateDir({ repoDir, env: { HAPPIER_STACK_STORAGE_DIR: storage } });
  const selected = await resolveQaGreenStateDir({ repoDir, env: { HAPPIER_STACK_STORAGE_DIR: storage,
    HAPPIER_STACK_STACK: 'repo-remote-dev-d72117acdb', HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-remote-dev-d72117acdb',
    HAPPIER_STACK_REPO_DIR: '/elsewhere/0.2' } });
  assert.equal(selected, plain);
  assert.ok(plain.startsWith(storage));
});
