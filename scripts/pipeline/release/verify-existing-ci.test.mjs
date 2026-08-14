import test from 'node:test';
import assert from 'node:assert/strict';

import { selectExactSuccessfulCiRun } from './verify-existing-ci.mjs';

const sha = 'a'.repeat(40);

test('selects only a successful same-repository push CI run for the exact source and branch', () => {
  const selected = selectExactSuccessfulCiRun([
    { id: 1, head_sha: sha, head_branch: 'dev', event: 'pull_request', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 2, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'failure', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 3, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'fork/happier' } },
    { id: 4, head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' });

  assert.equal(selected.id, 4);
});

test('fails when the exact source has no successful canonical push CI', () => {
  assert.throws(() => selectExactSuccessfulCiRun([
    { id: 5, head_sha: 'b'.repeat(40), head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
  ], { repository: 'happier-dev/happier', sourceSha: sha, sourceBranch: 'dev' }), /No successful exact-SHA push CI/);
});
