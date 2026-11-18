import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { checkRevisionOnBed, readQaGreen, resolveQaGreenStateDir, runQaGreenPass } from './qa_green.mjs';
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

// 2026-11-18: a green check sat 4 h inside its bed reload (a remote command whose script frame never came) holding
// check.lock, and stopping the checker left that reload running. Cancelling a check must stop its reload and say
// the check proved nothing, so the lock is released and the next kick checks HEAD again.
test('a cancelled green check stops its bed reload and reports the checker unavailable', { timeout: 30_000 }, async t => {
  const { repoDir, commit } = await gitRepo(t);
  const revision = await commit('one');
  const storage = join(repoDir, '..', 'stacks');
  await mkdir(join(storage, 'bed', 'qa-bed'), { recursive: true });
  await writeFile(join(storage, 'bed', 'env'), '');
  await writeFile(join(storage, 'bed', 'qa-bed', 'seed.json'), '{}');
  const pidFile = join(repoDir, '..', 'reload.pid');
  // The bed reload is a child process (the boundary); this one never settles, like the 4 h reload.
  await mkdir(join(repoDir, 'apps/stack/scripts'), { recursive: true });
  await writeFile(join(repoDir, 'apps/stack/scripts/repo_local.mjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`
      .replace("require('node:fs')", "(await import('node:fs'))"));
  const cancellation = new AbortController();
  const verdict = checkRevisionOnBed({ repoDir, stackName: 'bed', revision, env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: storage }, signal: cancellation.signal });
  let pid;
  while (!(pid = await readFile(pidFile, 'utf8').catch(() => ''))) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  cancellation.abort();
  assert.deepEqual(await verdict, { status: 'UNAVAILABLE', code: 'check_cancelled' });
  assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
});

// 2026-11-18: the checker bed's create failed at its first start, so it was never seeded or signed in. A check on it
// can only fail at sign-in and would mark a good HEAD NOT_READY; until `stack qa-bed create` finishes it proves nothing.
test('a checker bed that was never seeded is unavailable, not a NOT_READY verdict about HEAD', async t => {
  const { repoDir, commit } = await gitRepo(t);
  const revision = await commit('one');
  const storage = join(repoDir, '..', 'stacks');
  await mkdir(join(storage, 'bed'), { recursive: true });
  await writeFile(join(storage, 'bed', 'env'), '');
  const marker = join(repoDir, '..', 'reload-started');
  await mkdir(join(repoDir, 'apps/stack/scripts'), { recursive: true });
  await writeFile(join(repoDir, 'apps/stack/scripts/repo_local.mjs'), `(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, '1');`);
  assert.deepEqual(await checkRevisionOnBed({ repoDir, stackName: 'bed', revision, env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: storage } }),
    { status: 'UNAVAILABLE', code: 'checker_bed_not_seeded' });
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
});
