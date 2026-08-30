import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildWorkflowRunsEndpoint, selectExactCanonicalCiRun, selectExactSuccessfulCiRun } from './verify-existing-ci.mjs';

const sha = 'a'.repeat(40);

test('asks GitHub for the exact source SHA instead of reading a large recent-run window', () => {
  assert.equal(
    buildWorkflowRunsEndpoint('happier-dev/happier', 'tests.yml', 'dev', sha),
    `repos/happier-dev/happier/actions/workflows/tests.yml/runs?branch=dev&head_sha=${sha}&event=push&per_page=100`,
  );
});

test('selects only a successful same-repository push CI run for the exact source and branch', () => {
  const selected = selectExactSuccessfulCiRun([
    { id: 1, head_sha: sha, head_branch: 'dev', event: 'pull_request', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 2, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'failure', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 3, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'fork/happier' } },
    { id: 4, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' });

  assert.equal(selected.id, 4);
});

test('does not admit a newer failed duplicate merely because an older run succeeded', () => {
  assert.throws(() => selectExactSuccessfulCiRun([
    { id: 7, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 8, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'failure', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' }), /completed\/failure/);
});

test('selects an active exact-SHA canonical run so the release can wait for it', () => {
  const selected = selectExactCanonicalCiRun([
    { id: 6, head_sha: sha, head_branch: 'dev', event: 'push', status: 'in_progress', conclusion: null, head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' });

  assert.equal(selected.id, 6);
  assert.equal(selected.status, 'in_progress');
});

test('fails when the exact source has no successful canonical push CI', () => {
  assert.throws(() => selectExactSuccessfulCiRun([
    { id: 5, head_sha: 'b'.repeat(40), head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' }), /No exact-SHA push CI/);
});

test('exposes an explicit run-id input for completed CI attestation', () => {
  const source = readFileSync(new URL('./verify-existing-ci.mjs', import.meta.url), 'utf8');
  assert.match(source, /['\"]run-id['\"]/);
});
