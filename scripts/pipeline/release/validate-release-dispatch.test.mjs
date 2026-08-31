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
    waiveCi: false,
    includeValidationSuites: '',
    waiveValidationSuites: '',
    overrideReason: '',
    publicSdkReleaseApproval: '{}',
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
    overrides: { waiveCi: false, includeValidationSuiteIds: [], waiveValidationSuiteIds: [], reason: '' },
    publicSdkReleaseApproval: {
      pluginSdk: { ready: false, apiClassification: 'unreviewed', migrationNotes: 'not_required' },
      sdk: { authReadiness: 'not_ready', authWaiver: '', apiClassification: 'unreviewed', migrationNotes: 'not_required' },
    },
  });
});

test('normalizes the grouped public SDK approval with fail-closed structured input validation', () => {
  const result = validateReleaseDispatch(valid({
    publicSdkReleaseApproval: JSON.stringify({
      pluginSdk: { ready: true, apiClassification: 'compatible', migrationNotes: 'not_required' },
      sdk: { authReadiness: 'waived', authWaiver: 'preview-auth-review', apiClassification: 'breaking', migrationNotes: '2026.08.11-preview' },
    }),
  }));
  assert.deepEqual(result.publicSdkReleaseApproval, {
    pluginSdk: { ready: true, apiClassification: 'compatible', migrationNotes: 'not_required' },
    sdk: { authReadiness: 'waived', authWaiver: 'preview-auth-review', apiClassification: 'breaking', migrationNotes: '2026.08.11-preview' },
  });

  for (const publicSdkReleaseApproval of [
    '{',
    '[]',
    '{"pluginSdk":{"ready":"true"}}',
    '{"pluginSdk":{"unknown":true}}',
    '{"sdk":{"authReadiness":"maybe"}}',
    '{"extra":true}',
  ]) {
    assert.throws(
      () => validateReleaseDispatch(valid({ publicSdkReleaseApproval })),
      /public_sdk_release_approval/u,
    );
  }
});

test('accepts only explicit reasoned maintainer overrides and keeps them distinct from passing evidence', () => {
  const result = validateReleaseDispatch(valid({
    waiveCi: true,
    includeValidationSuites: 'installers-smoke',
    waiveValidationSuites: 'docker-release-assets,session-continuity',
    overrideReason: 'Maintainer accepted the bounded release risk for this exact candidate.',
  }));
  assert.deepEqual(result.overrides, {
    waiveCi: true,
    includeValidationSuiteIds: ['installers-smoke'],
    waiveValidationSuiteIds: ['docker-release-assets', 'session-continuity'],
    reason: 'Maintainer accepted the bounded release risk for this exact candidate.',
  });
  assert.throws(() => validateReleaseDispatch(valid({ waiveCi: true })), /override_reason is required/);
  assert.throws(() => validateReleaseDispatch(valid({ waiveValidationSuites: 'docker-release-assets' })), /override_reason is required/);
});

test('rejects unknown and identity-critical suite waivers before release mutation', () => {
  assert.throws(() => validateReleaseDispatch(valid({
    waiveValidationSuites: 'unknown-suite',
    overrideReason: 'Maintainer accepted the bounded release risk.',
  })), /Unknown release validation suite/);
  assert.throws(() => validateReleaseDispatch(valid({
    waiveValidationSuites: 'artifact-verify',
    overrideReason: 'Maintainer accepted the bounded release risk.',
  })), /cannot be waived/);
});

test('validates production from preview without a release-time bump decision', () => {
  const production = validateReleaseDispatch(valid({
    environment: 'production',
    confirm: 'release preview to main',
    refName: 'preview',
  }));
  assert.equal(production.sourceRef, 'preview');
  assert.equal(production.baseRef, 'main');
});

test('rejects partial candidate identity, resume conflicts, and untrusted dispatch refs', () => {
  assert.throws(() => validateReleaseDispatch(valid({ candidateRunId: '42' })), /requires run ID, version, and source SHA together/);
  assert.throws(() => validateReleaseDispatch(valid({
    candidateRunId: '42', candidateVersion: '1.2.3', candidateSourceSha: sha, resumeRunId: '77',
  })), /cannot combine/);
  assert.throws(() => validateReleaseDispatch(valid({ refName: 'feature/release' })), /untrusted ref/);
});
