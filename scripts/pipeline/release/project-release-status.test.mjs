import test from 'node:test';
import assert from 'node:assert/strict';

import { projectReleaseStatus } from './project-release-status.mjs';

test('each selected plugin keeps its own optional exact npm publication status', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '43', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/43', RELEASE_RUN_NAME: 'RELEASE', SOURCE_SHA: 'b'.repeat(40), RELEASE_CHANNEL: 'preview',
    CANDIDATE_RESULT: 'success', IMMUTABLE_VERIFICATION_RESULT: 'success', RELEASE_VERIFY_RESULT: 'success',
    REQUEST_PLUGINS: '["new-source-plugin"]',
    NPM_PLUGINS_JSON: JSON.stringify([{ id: 'new-source-plugin', packageName: '@example/custom-plugin', result: 'success', version: '0.3.0-preview.4', integrity: 'sha512-plugin' }]),
  });
  const plugin = status.surfaces.find(({ id }) => id === 'npm_plugin:new-source-plugin');
  assert.equal(plugin?.required, false);
  assert.equal(plugin?.state, 'complete');
  assert.equal(plugin?.identity?.package, '@example/custom-plugin');
  assert.equal(plugin?.identity?.version, '0.3.0-preview.4');
  const failed = projectReleaseStatus('standard', { RELEASE_RUN: '43', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/43', RELEASE_RUN_NAME: 'RELEASE', SOURCE_SHA: 'b'.repeat(40), RELEASE_CHANNEL: 'preview', REQUEST_PLUGINS: '["asciinema"]' });
  assert.equal(failed.surfaces.find(({ id }) => id === 'npm_plugin:asciinema')?.result, 'failed');
});

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

test('nightly status records the verified Runner candidate and rolling dev release', () => {
  const status = projectReleaseStatus('nightly', {
    RELEASE_RUN: '46',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/46',
    RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
    SOURCE_SHA: 'e'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    POST_PROMOTION_RESULT: 'success',
    RUNNER_CANDIDATE_RESULT: 'success',
    RUNNER_CANDIDATE_VERSION: '1.2.3-dev.4',
    RUNNER_RESULT: 'success',
  });

  const candidate = status.surfaces.find((surface) => surface.id === 'runner-immutable-candidate');
  assert.equal(candidate?.state, 'complete');
  assert.deepEqual(candidate?.identity, {
    sourceSha: 'e'.repeat(40),
    verified: true,
    product: 'runner',
    version: '1.2.3-dev.4',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'runner_rolling_release')?.state, 'complete');
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
  assert.equal(status.surfaces.find((surface) => surface.id === 'runner-immutable-candidate')?.state, 'not_requested');
  assert.equal(status.terminal, 'complete');
});

test('standard status projects a requested relay-only Docker publication failure as terminal failure', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '47',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/47',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'f'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'failure',
    REQUEST_DOCKER: 'true',
    DOCKER_RESULT: 'failure',
  });

  const docker = status.surfaces.find((surface) => surface.id === 'docker');
  assert.equal(docker?.requested, true);
  assert.equal(docker?.state, 'failed');
  assert.equal(docker?.result, 'failed');
  assert.equal(status.terminal, 'failed');
});

test('standard status records a verified Runner candidate and promoted release as one product', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '45',
    RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/45',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)',
    HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview',
    SOURCE_SHA: 'd'.repeat(40),
    CANDIDATE_RESULT: 'success',
    IMMUTABLE_VERIFICATION_RESULT: 'success',
    RELEASE_VERIFY_RESULT: 'success',
    REQUEST_RUNNER: 'true',
    RUNNER_CANDIDATE_RESULT: 'success',
    RUNNER_VERSION: '1.2.3-preview.4',
    RUNNER_RESULT: 'success',
  });
  const candidate = status.surfaces.find((surface) => surface.id === 'runner-immutable-candidate');
  assert.equal(candidate?.state, 'complete');
  assert.deepEqual(candidate?.identity, {
    sourceSha: 'd'.repeat(40),
    verified: true,
    product: 'runner',
    version: '1.2.3-preview.4',
  });
  assert.equal(status.surfaces.find((surface) => surface.id === 'runner_rolling_release')?.state, 'complete');
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
    REQUEST_RUNNER: 'true', RUNNER_CANDIDATE_RESULT: 'success', RUNNER_VERSION: '0.3.0',
    RUNNER_RESULT: 'skipped', RUNNER_ROLLING_RESUME_COMPLETE: 'true',
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
  assert.equal(status.surfaces.find((surface) => surface.id === 'runner_rolling_release')?.state, 'complete');
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

test('resumed rolling completion still requires current owner verification before it is reusable', () => {
  const status = projectReleaseStatus('standard', {
    RELEASE_RUN: '463', RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/463',
    RELEASE_RUN_NAME: 'RELEASE — Publish (rel_abcdefgh)', HMAINT_OPERATION_ID: 'rel_abcdefgh',
    RELEASE_CHANNEL: 'preview', SOURCE_SHA: 'd'.repeat(40), REQUEST_RUNNER: 'true',
    RUNNER_RESULT: 'skipped', RUNNER_ROLLING_RESUME_COMPLETE: 'true', RELEASE_VERIFY_RESULT: 'failure',
  });
  const runner = status.surfaces.find((surface) => surface.id === 'runner_rolling_release');
  assert.equal(runner.identity.verified, false);
  assert.notEqual(runner.state, 'complete');
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
  const preview = projectReleaseStatus('standard', { ...base, RELEASE_CHANNEL: 'preview', CHANNEL_PROMOTION_RESULT: 'success', GITHUB_LATEST_RESULT: 'skipped' });
  assert.equal(preview.surfaces.find((surface) => surface.id === 'github_latest')?.state, 'not_requested');
  assert.equal(preview.terminal, 'complete');
});
