import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildWorkflowRunsEndpoint,
  main,
  selectExactCanonicalCiRun,
  selectExactSuccessfulCiRun,
} from './verify-existing-ci.mjs';

const sha = 'a'.repeat(40);

test('asks GitHub for the exact source SHA instead of relying on a finite recent-run window', () => {
  assert.equal(
    buildWorkflowRunsEndpoint('happier-dev/happier', 'tests.yml', 'dev', sha),
    `repos/happier-dev/happier/actions/workflows/tests.yml/runs?branch=dev&head_sha=${sha}&per_page=100`,
  );
});

test('selects a successful same-repository trusted CI run for the exact source and branch', () => {
  const selected = selectExactSuccessfulCiRun([
    { id: 1, head_sha: sha, head_branch: 'dev', event: 'pull_request', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 2, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'failure', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 3, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'fork/happier' } },
    { id: 4, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' });

  assert.equal(selected.id, 4);
});

test('accepts an equivalent exact-SHA manual CI run from the canonical repository', () => {
  const selected = selectExactSuccessfulCiRun([
    { id: 6, head_sha: sha, head_branch: 'dev', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' });
  assert.equal(selected.id, 6);
});

test('selects an active trusted exact-SHA CI so the release can wait for it', () => {
  const selected = selectExactCanonicalCiRun([
    { id: 7, head_sha: sha, head_branch: 'dev', event: 'workflow_dispatch', status: 'queued', conclusion: null, head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' });
  assert.equal(selected.id, 7);
});

test('fails when the exact source has no successful canonical CI', () => {
  assert.throws(() => selectExactSuccessfulCiRun([
    { id: 5, head_sha: 'b'.repeat(40), head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' }), /No exact-SHA canonical CI/);
});

test('does not admit a newer failed trusted run merely because an older run succeeded', () => {
  assert.throws(() => selectExactSuccessfulCiRun([
    { id: 8, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 9, head_sha: sha, head_branch: 'dev', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' }), /completed\/failure/);
});

test('explicit run-id attestation fetches that run and writes evidence only for canonical successful push CI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ci-attestation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trustedRun = {
    id: 123, html_url: 'https://github.com/happier-dev/happier/actions/runs/123',
    path: '.github/workflows/tests.yml', head_sha: sha, head_branch: 'v0.3',
    event: 'push', head_repository: { full_name: 'happier-dev/happier' },
    status: 'completed', conclusion: 'success',
  };
  let response = trustedRun;
  // GitHub's process boundary is replaced; parsing, admission and evidence writes stay real.
  const requests = [];
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    requests.push([command, args]);
    return { status: 0, stdout: JSON.stringify(response), stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  for (const [label, overrides] of [
    ['trusted', {}],
    ['wrong-workflow', { path: '.github/workflows/other.yml' }],
    ['wrong-source', { head_sha: 'b'.repeat(40) }],
    ['wrong-branch', { head_branch: 'preview' }],
    ['manual-run', { event: 'workflow_dispatch' }],
    ['fork', { head_repository: { full_name: 'fork/happier' } }],
    ['pending', { status: 'in_progress' }],
    ['failed', { conclusion: 'failure' }],
  ]) {
    response = { ...trustedRun, ...overrides };
    requests.length = 0;
    const outputPath = join(root, label);
    const args = ['--repository', 'happier-dev/happier', '--source-sha', sha,
      '--source-branch', 'v0.3', '--run-id', '123', '--github-output', outputPath];
    if (label === 'trusted') {
      assert.deepEqual(await main(args), {
        runId: 123, runUrl: trustedRun.html_url, sourceSha: sha, sourceBranch: 'v0.3',
      });
      assert.equal(await readFile(outputPath, 'utf8'), `ci_run_id=123\nci_run_url=${trustedRun.html_url}\n`);
    } else {
      await assert.rejects(main(args), /not a successful canonical push CI/);
      await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
    }
    assert.deepEqual(requests, [['gh', ['api', 'repos/happier-dev/happier/actions/runs/123']]]);
  }
});

test('a release waits for the exact-SHA CI that is still running, then admits its success', async (t) => {
  const running = {
    id: 321, html_url: 'https://github.com/happier-dev/happier/actions/runs/321',
    path: '.github/workflows/tests.yml', head_sha: sha, head_branch: 'v0.3',
    event: 'push', head_repository: { full_name: 'happier-dev/happier' }, status: 'in_progress', conclusion: null,
  };
  let watched = false;
  let watchStatus = 0;
  const requests = [];
  // GitHub's process boundary is replaced; selection, waiting and admission stay real.
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    requests.push(args.slice(0, 2).join(' '));
    if (args[0] === 'run' && args[1] === 'watch') { watched = true; return { status: watchStatus, stdout: '', stderr: '' }; }
    const run = watched ? { ...running, status: 'completed', conclusion: watchStatus === 0 ? 'success' : 'failure' } : running;
    return { status: 0, stdout: JSON.stringify({ workflow_runs: [run] }), stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const args = ['--repository', 'happier-dev/happier', '--source-sha', sha, '--source-branch', 'v0.3'];

  assert.equal((await main(args)).runId, 321);
  assert.deepEqual(requests, ['api repos/happier-dev/happier/actions/workflows/tests.yml/runs?branch=v0.3&head_sha=' + sha + '&per_page=100', 'run watch',
    'api repos/happier-dev/happier/actions/workflows/tests.yml/runs?branch=v0.3&head_sha=' + sha + '&per_page=100']);

  watched = false;
  watchStatus = 1;
  await assert.rejects(main(args), /did not complete successfully/);
});
