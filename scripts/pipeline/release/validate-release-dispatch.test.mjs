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
  uiExpoAction: 'full',
  desktopMode: 'build_and_publish',
  environment: 'preview',
  dryRun: false,
  eventName: 'workflow_dispatch',
  refName: 'dev',
  qualifiedV4ActivationApproval: false,
  waiveCi: false,
  includeValidationSuites: '',
  waiveValidationSuites: '',
  overrideReason: '',
};

test('resolves preview source and comparison refs', () => {
  assert.deepEqual(validateReleaseDispatch(base), {
    mode: 'preview_release',
    sourceRef: 'dev',
    baseRef: 'preview',
    compareLabel: 'preview..dev',
    deployTargets: ['ui', 'server'],
    uiExpoAction: 'full',
    desktopMode: 'build_and_publish',
    overrides: { waiveCi: false, includeValidationSuiteIds: [], waiveValidationSuiteIds: [], reason: '' },
  });
});

test('rejects UI publication modes without the UI target', () => {
  assert.throws(
    () => validateReleaseDispatch({ ...base, deployTargets: 'server', uiExpoAction: 'full' }),
    /requires deploy_targets to include ui/u,
  );
  assert.throws(
    () => validateReleaseDispatch({ ...base, deployTargets: 'server', uiExpoAction: 'none', desktopMode: 'build_and_publish' }),
    /requires deploy_targets to include ui/u,
  );
});

test('requires an attempt identity for conductor-owned dispatches', () => {
  assert.throws(() => validateReleaseDispatch({ ...base, attemptId: '' }), /attempt_<positive integer>/u);
});

test('accepts an exact resume run identifier', () => {
  assert.equal(validateReleaseDispatch({ ...base, attemptId: 'attempt_2', resumeRunId: '1234' }).sourceRef, 'dev');
});

test('rejects untrusted refs and unsupported irreversible activation', () => {
  assert.throws(() => validateReleaseDispatch({ ...base, refName: 'feature/release' }), /untrusted ref/u);
  assert.throws(() => validateReleaseDispatch({ ...base, qualifiedV4ActivationApproval: true }), /not implemented/u);
});

test('accepts explicit reasoned waivers and rejects unknown or identity-critical suite waivers', () => {
  assert.deepEqual(validateReleaseDispatch({
    ...base,
    waiveCi: true,
    includeValidationSuites: 'installers-smoke',
    waiveValidationSuites: 'docker-release-assets',
    overrideReason: 'Maintainer accepted the bounded release risk.',
  }).overrides, {
    waiveCi: true,
    includeValidationSuiteIds: ['installers-smoke'],
    waiveValidationSuiteIds: ['docker-release-assets'],
    reason: 'Maintainer accepted the bounded release risk.',
  });
  assert.throws(() => validateReleaseDispatch({ ...base, waiveCi: true }), /override_reason is required/);
  assert.throws(() => validateReleaseDispatch({ ...base, waiveValidationSuites: 'unknown', overrideReason: 'reason' }), /Unknown release validation suite/);
  assert.throws(() => validateReleaseDispatch({ ...base, waiveValidationSuites: 'binary-smoke', overrideReason: 'reason' }), /cannot be waived/);
});
