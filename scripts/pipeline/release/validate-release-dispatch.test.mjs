import test from 'node:test';
import assert from 'node:assert/strict';

import { validateReleaseDispatch } from './validate-release-dispatch.mjs';

const sha = 'a'.repeat(40);

function valid(overrides = {}) {
  return {
    authorizedPromotionSourceSha: sha,
    candidateRunId: '',
    candidateVersion: '',
    candidateSourceSha: '',
    resumeRunId: '',
    operationId: 'rel_abcdefgh',
    attemptId: 'attempt_1',
    releaseNotesId: '2026.08.11-preview',
    bump: 'none',
    confirm: 'release dev to preview',
    deployTargets: 'ui,server,cli',
    environment: 'preview',
    dryRun: false,
    eventName: 'workflow_dispatch',
    refName: 'dev',
    ...overrides,
  };
}

test('validates a materialized preview release and resolves planning facts', () => {
  assert.deepEqual(validateReleaseDispatch(valid()), {
    mode: 'preview_release',
    sourceRef: 'dev',
    baseRef: 'preview',
    compareLabel: 'preview..dev',
    deployTargets: ['ui', 'server', 'cli'],
  });
});

test('validates production from preview and rejects non-materialized bumps', () => {
  const production = validateReleaseDispatch(valid({
    environment: 'production',
    confirm: 'release preview to main',
    refName: 'preview',
  }));
  assert.equal(production.sourceRef, 'preview');
  assert.equal(production.baseRef, 'main');
  assert.throws(() => validateReleaseDispatch(valid({ bump: 'patch' })), /bump=none/);
});

test('rejects partial candidate identity, resume conflicts, and untrusted dispatch refs', () => {
  assert.throws(() => validateReleaseDispatch(valid({ candidateRunId: '42' })), /requires run ID, version, and source SHA together/);
  assert.throws(() => validateReleaseDispatch(valid({
    candidateRunId: '42', candidateVersion: '1.2.3', candidateSourceSha: sha, resumeRunId: '77',
  })), /cannot combine/);
  assert.throws(() => validateReleaseDispatch(valid({ refName: 'feature/release' })), /untrusted ref/);
});
