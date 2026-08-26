import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReleaseValidationPlan } from './resolve-validation-plan.mjs';

test('validation plan keeps fast evidence and selects heavy suites only from changed seams', () => {
  assert.deepEqual(resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  }), {
    run_installers_smoke: 'false',
    run_artifact_verify: 'true',
    run_binary_smoke: 'true',
    run_cli_update_continuity: 'false',
    run_daemon_continuity: 'false',
    run_session_continuity: 'false',
    run_release_assets_docker: 'false',
    run_self_host_systemd: 'false',
    run_self_host_launchd: 'false',
    run_self_host_schtasks: 'false',
    run_self_host_daemon: 'false',
    waivedSuiteIds: [],
  });

  const affected = resolveReleaseValidationPlan({
    profileId: 'stable',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
  });
  assert.equal(affected.run_cli_update_continuity, 'true');
  assert.equal(affected.run_session_continuity, 'true');
  assert.equal(affected.run_release_assets_docker, 'true');
});

test('validation plan treats risk classification as defaults that an authorized release packet may refine', () => {
  const result = resolveReleaseValidationPlan({
    profileId: 'stable',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
    includeSuiteIds: ['installers-smoke'],
    waiveSuiteIds: ['docker-release-assets'],
  });
  assert.equal(result.run_installers_smoke, 'true');
  assert.equal(result.run_cli_update_continuity, 'true');
  assert.equal(result.run_release_assets_docker, 'false');
  assert.deepEqual(result.waivedSuiteIds, ['docker-release-assets']);
});

test('validation plan rejects unknown and intrinsically fast suite waivers', () => {
  const common = {
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  };
  assert.throws(() => resolveReleaseValidationPlan({ ...common, waiveSuiteIds: ['unknown'] }), /Unknown release validation suite/);
  assert.throws(() => resolveReleaseValidationPlan({ ...common, waiveSuiteIds: ['artifact-verify'] }), /cannot be waived/);
});
