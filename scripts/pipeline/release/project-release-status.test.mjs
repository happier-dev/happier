import test from 'node:test';
import assert from 'node:assert/strict';

import { projectReleaseStatus } from './project-release-status.mjs';

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
  });

  const cli = status.surfaces.find((surface) => surface.id === 'cli-immutable-candidate');
  assert.equal(cli?.state, 'complete');
  assert.equal(cli?.identity?.verified, true);
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
