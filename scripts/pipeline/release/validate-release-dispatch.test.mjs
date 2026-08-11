import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReleaseDispatch } from './validate-release-dispatch.mjs';

const sha = 'a'.repeat(40);
const base = {
  authorizedPromotionSourceSha: sha,
  operationId: 'rel_release01',
  attemptId: 'attempt_1',
  releaseNotesId: '2026.08.11-preview',
  bump: 'none',
  confirm: 'release dev to preview',
  deployTargets: 'ui,server',
  environment: 'preview',
  dryRun: false,
  eventName: 'workflow_dispatch',
  refName: 'dev',
};

test('resolves preview source and comparison refs', () => {
  assert.deepEqual(validateReleaseDispatch(base), {
    mode: 'preview_release',
    sourceRef: 'dev',
    baseRef: 'preview',
    compareLabel: 'preview..dev',
    deployTargets: ['ui', 'server'],
  });
});

test('requires an attempt identity for conductor-owned dispatches', () => {
  assert.throws(() => validateReleaseDispatch({ ...base, attemptId: '' }), /attempt_<positive integer>/u);
});

test('accepts an exact resume run identifier', () => {
  assert.equal(validateReleaseDispatch({ ...base, attemptId: 'attempt_2', resumeRunId: '1234' }).sourceRef, 'dev');
});

test('rejects old bump selection and untrusted refs', () => {
  assert.throws(() => validateReleaseDispatch({ ...base, bump: 'patch' }), /materialized/u);
  assert.throws(() => validateReleaseDispatch({ ...base, refName: 'feature/release' }), /untrusted ref/u);
});
