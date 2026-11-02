import test from 'node:test';
import assert from 'node:assert/strict';

import { projectReleaseStatus } from './project-release-status.mjs';

test('a published web product remains complete beside a failed CLI and pending deployment', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '42', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/42',
    RELEASE_RUN_NAME: 'RELEASE', RELEASE_CHANNEL: 'preview', SOURCE_SHA: 'a'.repeat(40),
    CANDIDATE_RESULT: 'success', IMMUTABLE_VERIFICATION_RESULT: 'failure', RELEASE_VERIFY_RESULT: 'skipped',
    REQUEST_CLI: 'true', CLI_CANDIDATE_RESULT: 'failure', CLI_RESULT: 'skipped',
    REQUEST_UI_WEB: 'true', UI_WEB_CANDIDATE_RESULT: 'success', UI_WEB_VERSION: '1.2.3-preview.4',
    UI_WEB_RESUME_VERIFIED: 'true', UI_WEB_RESULT: 'success',
    REQUEST_DEPLOY_DOCS: 'true', DEPLOY_DOCS_RESULT: 'pending',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'ui_web_rolling_release')?.state, 'complete');
  assert.equal(status.surfaces.find((surface) => surface.id === 'deploy_docs')?.result, 'pending');
  assert.equal(status.terminal, 'failed');
});

test('an admitted completed web product remains reusable through repeated partial resumes', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '42', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/42',
    RELEASE_RUN_NAME: 'RELEASE', RELEASE_CHANNEL: 'preview', SOURCE_SHA: 'a'.repeat(40),
    CANDIDATE_RESULT: 'success', IMMUTABLE_VERIFICATION_RESULT: 'failure', RELEASE_VERIFY_RESULT: 'skipped',
    REQUEST_CLI: 'true', CLI_CANDIDATE_RESULT: 'failure', CLI_RESULT: 'skipped',
    REQUEST_UI_WEB: 'true', UI_WEB_CANDIDATE_RESULT: 'success', UI_WEB_VERSION: '1.2.3-preview.4',
    UI_WEB_RESUME_VERIFIED: 'true', UI_WEB_RESULT: 'skipped', UI_WEB_ROLLING_RESUME_COMPLETE: 'true',
    REQUEST_DEPLOY_DOCS: 'true', DEPLOY_DOCS_RESULT: 'pending',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'ui_web_rolling_release')?.state, 'complete');
  assert.equal(status.surfaces.find((surface) => surface.id === 'deploy_docs')?.result, 'pending');
  assert.equal(status.terminal, 'failed');
});

test('nightly status reports a CI-blocked scheduled head as terminal failure', () => {
  const status = projectReleaseStatus('nightly', {
    RELEASE_RUN: '40',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/40',
    RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
    SOURCE_SHA: '0'.repeat(40),
    NIGHTLY_DECISION: 'blocked_ci',
  });

  assert.equal(status.terminal, 'failed');
  assert.deepEqual(status.surfaces.map(({ id, state }) => ({ id, state })), [
    { id: 'source_ci_admission', state: 'failed' },
  ]);
});

test('nightly status reports an already promoted certified head as complete', () => {
  const status = projectReleaseStatus('nightly', {
    RELEASE_RUN: '41',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/41',
    RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
    SOURCE_SHA: '1'.repeat(40),
    NIGHTLY_DECISION: 'already_current',
  });

  assert.equal(status.terminal, 'complete');
  assert.deepEqual(status.surfaces.map(({ id, state }) => ({ id, state })), [
    { id: 'rolling_release_current', state: 'complete' },
  ]);
});

test('nightly status preserves an independently verified sibling after grouped failure', () => {
  const status = projectReleaseStatus('nightly', {
    RELEASE_RUN: '42',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/42',
    RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
    SOURCE_SHA: 'a'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'failure',
    CLI_CANDIDATE_RESULT: 'success',
    CLI_CANDIDATE_VERSION: '1.2.3-dev.4',
    CLI_RESUME_VERIFIED: 'true',
    DESKTOP_ORIGIN_RUN_ID: '37',
  });

  const cli = status.surfaces.find((surface) => surface.id === 'cli-immutable-candidate');
  assert.equal(cli?.state, 'complete');
  assert.equal(cli?.identity?.verified, true);
  assert.equal(status.surfaces.find((surface) => surface.id === 'ui_desktop')?.identity?.candidateOriginRunId, 37);
  assert.equal(status.terminal, 'failed');
});

test('standard status keeps unrequested surfaces out of failure admission', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '43',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/43',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'b'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'docker')?.state, 'not_requested');
  assert.equal(status.terminal, 'complete');
});

test('standard status keeps a requested skipped Docker publication visible as partial', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '44',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/44',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'c'.repeat(40),
    REQUEST_DOCKER: 'true',
    DOCKER_RESULT: 'skipped',
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  const docker = status.surfaces.find((surface) => surface.id === 'docker');
  assert.equal(docker?.requested, true);
  assert.equal(docker?.state, 'partial');
  assert.equal(status.terminal, 'partial');
});

test('standard status fails when a requested UI delivery is skipped after core signoff', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '45',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/45',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'd'.repeat(40),
    REQUEST_DEPLOY_UI: 'true',
    DEPLOY_UI_RESULT: 'skipped',
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  const deployUi = status.surfaces.find((surface) => surface.id === 'deploy_ui');
  assert.equal(deployUi?.requested, true);
  assert.equal(deployUi?.state, 'failed');
  assert.equal(status.terminal, 'failed');
});

test('standard status treats a requested full UI delivery as required and preserves its exact intent', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '451',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/451',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'production',
    SOURCE_SHA: 'd'.repeat(40),
    REQUEST_DEPLOY_UI: 'true',
    DEPLOY_UI_RESULT: 'success',
    DEPLOY_UI_WEB: 'true',
    DEPLOY_UI_EXPO_ACTION: 'full',
    DEPLOY_UI_DESKTOP_MODE: 'build_and_publish',
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  const deployUi = status.surfaces.find((surface) => surface.id === 'deploy_ui');
  assert.equal(deployUi?.required, true);
  assert.deepEqual(deployUi?.identity, {
    sourceSha: 'd'.repeat(40),
    verified: false,
    deployWeb: true,
    expoAction: 'full',
    desktopMode: 'build_and_publish',
  });
});

test('standard status carries accepted downstream evidence across a control-fixed resume', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '46',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/46',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'e'.repeat(40),
    REQUEST_DOCKER: 'true',
    DOCKER_RESULT: 'skipped',
    DOCKER_RESUME_COMPLETE: 'true',
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  const docker = status.surfaces.find((surface) => surface.id === 'docker');
  assert.equal(docker?.requested, true);
  assert.equal(docker?.result, 'accepted');
  assert.equal(docker?.state, 'published');
  assert.equal(status.terminal, 'published');
});

test('standard status carries verified rolling projections across a control-fixed resume', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '47',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/47',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'f'.repeat(40),
    REQUEST_CLI: 'true',
    CLI_CANDIDATE_RESULT: 'success',
    CLI_VERSION: '0.2.11-preview.1',
    CLI_RESUME_VERIFIED: 'true',
    CLI_RESULT: 'skipped',
    CLI_ROLLING_RESUME_COMPLETE: 'true',
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  const rolling = status.surfaces.find((surface) => surface.id === 'cli_rolling_release');
  assert.equal(rolling?.result, 'success');
  assert.equal(rolling?.state, 'complete');
  assert.equal(rolling?.identity?.verified, true);
  assert.equal(status.terminal, 'complete');
});


test('channel promotion failure does not erase independently published products or report complete release', () => {
  const base = {
    RELEASE_RUN: '42', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/42',
    RELEASE_RUN_NAME: 'RELEASE', RELEASE_CHANNEL: 'production', SOURCE_SHA: 'a'.repeat(40),
    CANDIDATE_RESULT: 'success', IMMUTABLE_VERIFICATION_RESULT: 'success', RELEASE_VERIFY_RESULT: 'success',
    REQUEST_SERVER: 'true', SERVER_CANDIDATE_RESULT: 'success', SERVER_VERSION: '1.2.3', SERVER_RESULT: 'success',
  };
  for (const [result, state] of [['failure', 'failed'], ['pending', 'partial'], ['success', 'complete']]) {
    const status = projectReleaseStatus('standard', { ...base, CHANNEL_PROMOTION_RESULT: result });
    assert.equal(status.surfaces.find((surface) => surface.id === 'server_rolling_release')?.state, 'complete');
    assert.equal(status.surfaces.find((surface) => surface.id === 'channel_promotion')?.state, state);
    assert.equal(status.terminal, state);
  }
  for (const [result, state] of [['failure', 'failed'], ['pending', 'partial'], ['success', 'published']]) {
    const status = projectReleaseStatus('standard', { ...base, CHANNEL_PROMOTION_RESULT: 'success', GITHUB_LATEST_RESULT: result });
    assert.equal(status.surfaces.find((surface) => surface.id === 'server_rolling_release')?.state, 'complete');
    assert.equal(status.surfaces.find((surface) => surface.id === 'github_latest')?.state, state);
    assert.equal(status.terminal, state);
  }
  const tapFailure = projectReleaseStatus('standard', { ...base, REQUEST_HOMEBREW: 'true', HOMEBREW_RESULT: 'failure' });
  assert.equal(tapFailure.surfaces.find((surface) => surface.id === 'homebrew_tap')?.state, 'failed');
  assert.equal(tapFailure.surfaces.find((surface) => surface.id === 'server_rolling_release')?.state, 'complete');
  assert.equal(tapFailure.terminal, 'failed');
  const preview = projectReleaseStatus('standard', { ...base, RELEASE_CHANNEL: 'preview', CHANNEL_PROMOTION_RESULT: 'success', GITHUB_LATEST_RESULT: 'skipped' });
  assert.equal(preview.surfaces.find((surface) => surface.id === 'github_latest')?.state, 'not_requested');
  assert.equal(preview.terminal, 'complete');
});
