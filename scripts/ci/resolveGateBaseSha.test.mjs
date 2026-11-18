import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveGateBaseSha } from './resolveGateBaseSha.mjs';

async function repository(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-gate-base-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = async (name) => {
    await writeFile(join(repoRoot, name), name);
    git('add', name);
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  return { repoRoot, commit };
}

// The GitHub REST API is the external boundary. A pending run that concurrency
// replaced is cancelled before any job is created, so it lists no jobs.
function githubApi({ runs, jobsByRun }) {
  const requests = [];
  return {
    requests,
    ghApi: async (path) => {
      requests.push(path);
      if (path.includes('/workflows/tests.yml/runs?')) return { workflow_runs: runs };
      const runId = /\/runs\/(\d+)\/jobs/u.exec(path)?.[1];
      if (runId) return { total_count: jobsByRun[runId] ?? 0, jobs: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('a push diffs against the newest earlier run that started, so commits of replaced pending runs stay selected', async t => {
  const { repoRoot, commit } = await repository(t);
  const started = await commit('started');
  const replacedA = await commit('replaced-a');
  const replacedB = await commit('replaced-b');
  const head = await commit('head');
  const { ghApi } = githubApi({
    runs: [
      { id: 40, head_sha: head },
      { id: 30, head_sha: replacedB, conclusion: 'cancelled' },
      { id: 20, head_sha: replacedA, conclusion: 'cancelled' },
      { id: 10, head_sha: started, conclusion: 'failure' },
    ],
    jobsByRun: { 10: 12 },
  });
  const base = await resolveGateBaseSha({ repoRoot, eventName: 'push', repository: 'o/r', branch: 'v0.3',
    runId: '40', headSha: head, ghApi });
  assert.equal(base, started);
});

test('pull requests keep their merge base and a push without a usable started run selects everything', async t => {
  const { repoRoot, commit } = await repository(t);
  const first = await commit('first');
  const head = await commit('head');
  const { ghApi, requests } = githubApi({ runs: [], jobsByRun: {} });
  assert.equal(await resolveGateBaseSha({ repoRoot, eventName: 'pull_request', pullRequestBaseSha: first,
    headSha: head, ghApi }), first);
  assert.deepEqual(requests, []);
  // No earlier started run (or one whose commit this clone lacks) is not proof
  // that nothing changed: the empty base widens selection to the whole tree.
  assert.equal(await resolveGateBaseSha({ repoRoot, eventName: 'push', repository: 'o/r', branch: 'v0.3',
    runId: '40', headSha: head, ghApi }), '');
  const missing = githubApi({ runs: [{ id: 10, head_sha: 'f'.repeat(40) }], jobsByRun: { 10: 3 } });
  assert.equal(await resolveGateBaseSha({ repoRoot, eventName: 'push', repository: 'o/r', branch: 'v0.3',
    runId: '40', headSha: head, ghApi: missing.ghApi }), '');
});
