import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { postCommittedAdvanceRefusal, readCommittedHead, startCommittedHeadFollower, startCommittedStackFollower } from './committed_head_follower.mjs';

const execFileAsync = promisify(execFile);
const quiet = { log() {}, warn() {}, error() {} };

async function createRepo(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-committed-head-' });
  const repoDir = fixture.root;
  const git = async (...args) => (await execFileAsync('git', ['-C', repoDir, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'lane@example.invalid');
  await git('config', 'user.name', 'Lane');
  let count = 0;
  const commit = async () => {
    count += 1;
    await writeFile(join(repoDir, 'file.txt'), `${count}\n`);
    await git('add', 'file.txt');
    await git('commit', '-q', '-m', `change ${count}`);
    return await git('rev-parse', 'HEAD');
  };
  return { repoDir, git, commit };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label) {
  // fs.watch delivery is asynchronous; the follower has no timer of its own.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const settle = () => new Promise(done => setTimeout(done, 1_500));

test('a commit advances a committed Stack to the new HEAD once', async t => {
  const { repoDir, commit } = await createRepo(t);
  const incumbent = await commit();
  const reloads = [];
  const follower = await startCommittedHeadFollower({ repoDir, loadedRevision: incumbent, logger: quiet,
    advance: async rev => { reloads.push(rev); } });
  t.after(() => follower.close());
  await settle();
  assert.deepEqual(reloads, [], 'an unchanged HEAD reloads nothing');
  const next = await commit();
  await waitFor(() => reloads.length === 1, 'one reload');
  await settle();
  assert.deepEqual(reloads, [next]);
});

test('a burst of commits during an advance ends in one more advance, to the newest HEAD', async t => {
  const { repoDir, commit } = await createRepo(t);
  const incumbent = await commit();
  const reloads = [];
  const first = deferred();
  const follower = await startCommittedHeadFollower({ repoDir, loadedRevision: incumbent, logger: quiet,
    advance: async rev => { reloads.push(rev); if (reloads.length === 1) await first.promise; } });
  t.after(() => follower.close());
  const firstHead = await commit();
  await waitFor(() => reloads.length === 1, 'the first reload');
  const burst = [];
  for (let index = 0; index < 5; index += 1) burst.push(await commit());
  await settle();
  assert.deepEqual(reloads, [firstHead], 'no reload starts while one is in flight');
  first.resolve();
  await waitFor(() => reloads.length === 2, 'the trailing reload');
  await settle();
  assert.deepEqual(reloads, [firstHead, burst.at(-1)]);
});

test('a refused advance keeps the loaded revision, reports once on the board, and retries on the next commit', async t => {
  const { repoDir, commit } = await createRepo(t);
  const incumbent = await commit();
  const board = join(repoDir, 'BOARD.md');
  await writeFile(board, '# Board\n\n');
  const refused = await commit();
  // The lane that posted this commit's SHA is named on the refusal.
  await writeFile(board, `# Board\n\n### 2026-11-16 21:00 UTC — LANE-X → P03 ORCH — RESULT — committed ${refused.slice(0, 11)}\nbody\n`);
  const states = [];
  const reloads = [];
  let failNext = 2;
  const follower = await startCommittedHeadFollower({ repoDir, loadedRevision: incumbent, logger: quiet,
    stackName: 'repo-dev-sample',
    onState: async state => { states.push({ phase: state.phase, loaded: state.loaded, head: state.head }); },
    report: refusal => postCommittedAdvanceRefusal({ repoDir, board, stackName: 'repo-dev-sample', ...refusal }),
    advance: async rev => {
      reloads.push(rev);
      if (failNext > 0) {
        failNext -= 1;
        throw Object.assign(new Error('[reload] replacement refused; incumbent retained: server smoke failed'), { code: 'source_reload_refused' });
      }
    } });
  t.after(() => follower.close());
  await waitFor(() => states.some(state => state.phase === 'refused'), 'the refusal');
  const second = await commit();
  await waitFor(() => states.filter(state => state.phase === 'refused').length === 2, 'the second refusal');
  const third = await commit();
  await waitFor(() => states.some(state => state.phase === 'following'), 'recovery');
  await settle();
  assert.deepEqual(reloads, [refused, second, third]);
  assert.deepEqual(states.filter(state => state.phase !== 'advancing'), [
    { phase: 'refused', loaded: incumbent, head: refused },
    { phase: 'refused', loaded: incumbent, head: second },
    { phase: 'following', loaded: third, head: third },
  ], 'the incumbent stays loaded until a reload succeeds');
  const text = await readFile(board, 'utf8');
  const posts = text.match(/^### .*$/gm);
  assert.equal(posts.length, 2, 'one refusal post while refusals continue, beside the lane post');
  assert.match(posts[0], /repo-dev-sample.*→ Systemic, LANE-X — URGENT — /);
  assert.match(text, new RegExp(incumbent.slice(0, 11)));
  assert.match(text, /source_reload_refused/);
});

test('readCommittedHead names the checkout HEAD', async t => {
  const { repoDir, commit } = await createRepo(t);
  const head = await commit();
  assert.equal(await readCommittedHead(repoDir), head);
});

test('committed mode fast-forwards its own worktree to the primary checkout\'s newest HEAD and never runs the primary', async t => {
  const { repoDir, git, commit } = await createRepo(t);
  const start = await commit();
  const worktreeDir = `${repoDir}-committed`;
  await git('worktree', 'add', '--detach', '-q', worktreeDir, 'HEAD');
  t.after(() => execFileAsync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreeDir]).catch(() => {}));
  const runtimeStatePath = join(repoDir, '..', `${worktreeDir.split('/').pop()}.runtime.json`);
  await writeFile(runtimeStatePath, '{}');
  t.after(() => execFileAsync('rm', ['-f', runtimeStatePath]));
  await assert.rejects(startCommittedStackFollower({ worktreeDir: repoDir, stackName: 's', logger: quiet }),
    { code: 'committed_checkout_not_worktree' });
  const follower = await startCommittedStackFollower({ worktreeDir, stackName: 's', runtimeStatePath, logger: quiet });
  t.after(() => follower.close());
  const worktreeHead = async () => (await execFileAsync('git', ['-C', worktreeDir, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(await worktreeHead(), start);
  const burst = [];
  for (let index = 0; index < 3; index += 1) burst.push(await commit());
  await waitFor(async () => await worktreeHead() === burst.at(-1), 'the worktree at the newest HEAD');
  assert.equal(await readFile(join(worktreeDir, 'file.txt'), 'utf8'), await readFile(join(repoDir, 'file.txt'), 'utf8'));
  await waitFor(async () => JSON.parse(await readFile(runtimeStatePath, 'utf8')).committedHead?.loaded === burst.at(-1), 'the status');
  assert.equal(JSON.parse(await readFile(runtimeStatePath, 'utf8')).committedHead.phase, 'following');
  // A local edit in the committed worktree that the next commit would overwrite refuses; the loaded revision stays.
  await writeFile(join(worktreeDir, 'file.txt'), 'local edit\n');
  const blocked = await commit();
  await waitFor(async () => JSON.parse(await readFile(runtimeStatePath, 'utf8')).committedHead?.phase === 'refused', 'the refusal');
  const status = JSON.parse(await readFile(runtimeStatePath, 'utf8')).committedHead;
  assert.deepEqual([status.loaded, status.head, status.refusal.code], [burst.at(-1), blocked, 'committed_checkout_refused']);
  assert.equal(await worktreeHead(), burst.at(-1));
});
