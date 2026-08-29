import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkflowRunsEndpoint,
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
