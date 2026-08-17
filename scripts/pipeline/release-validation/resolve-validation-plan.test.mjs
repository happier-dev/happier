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

test('validation plan retains explicit legacy selections only when no profile is supplied', () => {
  const result = resolveReleaseValidationPlan({
    profileId: '',
    hasCliCandidate: false,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
    legacy: { run_binary_smoke: 'true', run_release_assets_docker: 'false' },
  });
  assert.equal(result.run_binary_smoke, 'true');
  assert.equal(result.run_release_assets_docker, 'false');
});
