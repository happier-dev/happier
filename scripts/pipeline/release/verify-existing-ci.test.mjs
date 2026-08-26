import test from 'node:test';
import assert from 'node:assert/strict';

import { selectExactSuccessfulCiRun } from './verify-existing-ci.mjs';

const sha = 'a'.repeat(40);

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

test('fails when the exact source has no successful canonical CI', () => {
  assert.throws(() => selectExactSuccessfulCiRun([
    { id: 5, head_sha: 'b'.repeat(40), head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' }), /No successful exact-SHA canonical CI/);
});
