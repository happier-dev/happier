import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReleaseValidationPlan, resolveReleaseValidationSuiteGate } from './resolve-validation-plan.mjs';

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
    skippedSuites: [
      'session-continuity (no session-continuity risk)',
      'cli-update (no CLI-upgrade risk)',
      'docker-release-assets (no relay-upgrade risk)',
    ],
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
  assert.equal(Object.hasOwn(affected, 'run_desktop_setup'), false, 'release verification does not run desktop-setup');
});

test('desktop-setup is a desktop-build gate: release verification refuses to include or waive it', () => {
  const plan = (overrides) => resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
    ...overrides,
  });
  assert.throws(() => plan({ includeSuiteIds: ['desktop-setup'] }), /desktop-setup is not run by release verification/);
  assert.throws(() => plan({ waiveSuiteIds: ['desktop-setup'] }), /desktop-setup is not run by release verification/);
});

test('the desktop-build gate resolves desktop-setup through the registry with a budget-derived timeout', () => {
  const gate = (overrides) => resolveReleaseValidationSuiteGate({
    suiteId: 'desktop-setup',
    hasDesktopCandidate: true,
    candidateCliVersion: '0.2.13',
    candidateChannel: 'production',
    ...overrides,
  });
  assert.deepEqual(gate({}), { run: 'true', skip_reason: '', timeout_minutes: '20', cli_source: 'published-tag', cli_ref: 'cli-v0.2.13' });
  // Desktop-only release: the published stable CLI users would get.
  assert.deepEqual(gate({ candidateCliVersion: '' }), { run: 'true', skip_reason: '', timeout_minutes: '20', cli_source: 'published-channel', cli_ref: 'stable' });
  assert.deepEqual(gate({ candidateChannel: 'preview' }), {
    run: 'false',
    skip_reason: 'no pinned preview predecessor for the upgrade scenario',
    timeout_minutes: '20',
    cli_source: '',
    cli_ref: '',
  });
  assert.equal(gate({ candidateChannel: 'dev' }).skip_reason, 'no pinned dev predecessor for the upgrade scenario');
  assert.throws(() => gate({ suiteId: 'unknown' }), /Unknown release validation suite/);
});

test('validation plan supports explicit reasoned refinements without a legacy flag matrix', () => {
  const result = resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
    risks: { cliUpgrade: true, sessionContinuity: true, relayUpgrade: true },
    includeSuiteIds: ['installers-smoke'],
    waiveSuiteIds: ['docker-release-assets'],
  });
  assert.equal(result.run_installers_smoke, 'true');
  assert.equal(result.run_release_assets_docker, 'false');
  assert.deepEqual(result.waivedSuiteIds, ['docker-release-assets']);
  assert.throws(() => resolveReleaseValidationPlan({
    profileId: '',
    hasCliCandidate: false,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
  }), /profile is required/);
  assert.throws(() => resolveReleaseValidationPlan({
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false },
    waiveSuiteIds: ['artifact-verify'],
  }), /cannot be waived/);
});

test('matching admitted source Binary Smoke replaces only the general source-built suite', () => {
  const input = { profileId: 'integrated', hasCliCandidate: true, hasServerCandidate: true,
    hasPublishedRelayPredecessor: false, risks: { cliUpgrade: false, sessionContinuity: false, relayUpgrade: false } };
  assert.equal(resolveReleaseValidationPlan(input).run_binary_smoke, 'true');
  const reused = resolveReleaseValidationPlan({ ...input, sourceBinarySmokeValidated: true });
  assert.equal(reused.run_binary_smoke, 'false');
  assert.equal(reused.run_artifact_verify, 'true');
});
