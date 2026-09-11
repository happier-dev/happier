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

test('standard status records independently verified identities for each requested public SDK package', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '44',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/44',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'c'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
    REQUEST_NPM: 'true',
    NPM_RESULT: 'success',
    REQUEST_PLUGIN_SDK: 'true',
    NPM_PLUGIN_SDK_RESULT: 'success',
    NPM_PLUGIN_SDK_VERSION: '0.1.0-preview.7',
    NPM_PLUGIN_SDK_INTEGRITY: 'sha512-plugin-sdk',
    NPM_PLUGIN_UI_RESULT: 'success',
    NPM_PLUGIN_UI_VERSION: '0.1.0-preview.7',
    NPM_PLUGIN_UI_INTEGRITY: 'sha512-plugin-ui',
    REQUEST_SDK: 'true',
    NPM_SDK_RESULT: 'success',
    NPM_SDK_VERSION: '0.1.0-preview.3',
    NPM_SDK_INTEGRITY: 'sha512-sdk',
  });

  assert.deepEqual(status.surfaces.filter((surface) => surface.id.startsWith('npm_')).map((surface) => ({
    id: surface.id,
    state: surface.state,
    identity: surface.identity,
  })), [
    {
      id: 'npm_plugin_sdk',
      state: 'complete',
      identity: {
        package: '@happier-dev/plugin-sdk',
        version: '0.1.0-preview.7',
        integrity: 'sha512-plugin-sdk',
        sourceSha: 'c'.repeat(40),
        verified: true,
      },
    },
    {
      id: 'npm_plugin_ui',
      state: 'complete',
      identity: {
        package: '@happier-dev/plugin-ui',
        version: '0.1.0-preview.7',
        integrity: 'sha512-plugin-ui',
        sourceSha: 'c'.repeat(40),
        verified: true,
      },
    },
    {
      id: 'npm_sdk',
      state: 'complete',
      identity: {
        package: '@happier-dev/sdk',
        version: '0.1.0-preview.3',
        integrity: 'sha512-sdk',
        sourceSha: 'c'.repeat(40),
        verified: true,
      },
    },
  ]);
});

test('standard status carries successful downstream work and UI intent across a control-fixed resume', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '46', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/46',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)', HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'production', SOURCE_SHA: 'e'.repeat(40),
    REQUEST_DEPLOY_UI: 'true', DEPLOY_UI_RESULT: 'skipped', DEPLOY_UI_RESUME_COMPLETE: 'true',
    DEPLOY_UI_WEB: 'true', DEPLOY_UI_EXPO_ACTION: 'full', DEPLOY_UI_DESKTOP_MODE: 'build_and_publish',
    REQUEST_DOCKER: 'true', DOCKER_RESULT: 'skipped', DOCKER_RESUME_COMPLETE: 'true',
    REQUEST_CLI: 'true', CLI_CANDIDATE_RESULT: 'success', CLI_VERSION: '0.3.0', CLI_RESUME_VERIFIED: 'true',
    CLI_RESULT: 'skipped', CLI_ROLLING_RESUME_COMPLETE: 'true',
    CANDIDATE_RESULT: 'success', IMMUTABLE_VERIFICATION_RESULT: 'success', RELEASE_VERIFY_RESULT: 'success',
  });
  const deployUi = status.surfaces.find((surface) => surface.id === 'deploy_ui');
  assert.equal(deployUi?.required, true);
  assert.equal(deployUi?.state, 'published');
  assert.deepEqual(deployUi?.identity, {
    sourceSha: 'e'.repeat(40), verified: false, deployWeb: true,
    expoAction: 'full', desktopMode: 'build_and_publish',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'docker')?.state, 'published');
  const rolling = status.surfaces.find((surface) => surface.id === 'cli_rolling_release');
  assert.equal(rolling?.state, 'complete');
  assert.equal(rolling?.identity?.verified, true);
});

test('standard status fails when requested UI delivery is skipped without verified resume evidence', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '462', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/462',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)', HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview', SOURCE_SHA: 'd'.repeat(40), REQUEST_DEPLOY_UI: 'true',
    DEPLOY_UI_RESULT: 'skipped', DEPLOY_UI_WEB: 'true', DEPLOY_UI_EXPO_ACTION: 'none',
    DEPLOY_UI_DESKTOP_MODE: 'none', CANDIDATE_RESULT: 'success', IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'deploy_ui')?.state, 'failed');
  assert.equal(status.terminal, 'failed');
});
