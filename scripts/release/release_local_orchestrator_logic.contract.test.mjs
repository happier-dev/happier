import test from 'node:test';
import assert from 'node:assert/strict';

import { computeReleaseExecutionPlan } from '../../scripts/pipeline/release/lib/release-orchestrator.mjs';

test('preview: ui target runs publish_ui_web but does not deploy web by default', () => {
  const plan = computeReleaseExecutionPlan({
    environment: 'preview',
    dryRun: false,
    forceDeploy: false,
    deployTargets: ['ui', 'server', 'website', 'docs'],
    uiExpoAction: 'none',
    desktopMode: 'none',
    changed: {
      changed_ui: false,
      changed_cli: false,
      changed_server: false,
      changed_website: false,
      changed_docs: false,
      changed_shared: false,
      changed_stack: false,
    },
    bumpPlan: {
      bump_app: 'none',
      bump_cli: 'none',
      bump_stack: 'none',
      bump_server: 'none',
      bump_website: 'none',
      should_bump: false,
      publish_cli: false,
      publish_stack: false,
      publish_server: false,
    },
    deployPlan: null,
  });

  assert.equal(plan.runPublishUiWeb, true);
  assert.equal(plan.runDeployUi, false);
});

test('preview: changed cli publishes docker dev-box but not relay', () => {
  const plan = computeReleaseExecutionPlan({
    environment: 'preview',
    dryRun: false,
    forceDeploy: false,
    deployTargets: ['cli'],
    uiExpoAction: 'none',
    desktopMode: 'none',
    changed: {
      changed_ui: false,
      changed_cli: true,
      changed_server: false,
      changed_website: false,
      changed_docs: false,
      changed_shared: false,
      changed_stack: false,
    },
    bumpPlan: {
      bump_app: 'none',
      bump_cli: 'none',
      bump_stack: 'none',
      bump_server: 'none',
      bump_website: 'none',
      should_bump: false,
      publish_cli: true,
      publish_stack: false,
      publish_server: false,
    },
    deployPlan: null,
  });

  assert.equal(plan.runPublishDocker, true);
  assert.equal(plan.dockerBuildDevBox, true);
  assert.equal(plan.dockerBuildRelay, false);
});

test('production: ui deploy runs when deploy plan says needed', () => {
  const plan = computeReleaseExecutionPlan({
    environment: 'production',
    dryRun: false,
    forceDeploy: false,
    deployTargets: ['ui'],
    uiExpoAction: 'none',
    desktopMode: 'none',
    changed: {
      changed_ui: true,
      changed_cli: false,
      changed_server: false,
      changed_website: false,
      changed_docs: false,
      changed_shared: false,
      changed_stack: false,
    },
    bumpPlan: {
      bump_app: 'none',
      bump_cli: 'none',
      bump_stack: 'none',
      bump_server: 'none',
      bump_website: 'none',
      should_bump: false,
      publish_cli: false,
      publish_stack: false,
      publish_server: false,
    },
    deployPlan: {
      deploy_ui: { needed: true },
      deploy_server: { needed: false },
      deploy_website: { needed: false },
      deploy_docs: { needed: false },
    },
  });

  assert.equal(plan.runPromoteMain, true);
  assert.equal(plan.runDeployUi, true);
  assert.equal(plan.runPublishUiWeb, false);
});

test('preview: server_runner triggers publish_server_runtime', () => {
  const plan = computeReleaseExecutionPlan({
    environment: 'preview',
    dryRun: false,
    forceDeploy: false,
    deployTargets: ['server_runner'],
    uiExpoAction: 'none',
    desktopMode: 'none',
    changed: {
      changed_ui: false,
      changed_cli: false,
      changed_server: false,
      changed_website: false,
      changed_docs: false,
      changed_shared: false,
      changed_stack: false,
    },
    bumpPlan: {
      bump_app: 'none',
      bump_cli: 'none',
      bump_stack: 'none',
      bump_server: 'none',
      bump_website: 'none',
      should_bump: false,
      publish_cli: false,
      publish_stack: false,
      publish_server: true,
    },
    deployPlan: null,
  });

  assert.equal(plan.runPublishServerRuntime, true);
});

test('dry-run: no mutating jobs run', () => {
  const plan = computeReleaseExecutionPlan({
    environment: 'production',
    dryRun: true,
    forceDeploy: true,
    deployTargets: ['ui', 'server', 'website', 'docs', 'cli', 'stack', 'server_runner'],
    uiExpoAction: 'native_submit',
    desktopMode: 'build_and_publish',
    changed: {
      changed_ui: true,
      changed_cli: true,
      changed_server: true,
      changed_website: true,
      changed_docs: true,
      changed_shared: true,
      changed_stack: true,
    },
    bumpPlan: {
      bump_app: 'major',
      bump_cli: 'major',
      bump_stack: 'major',
      bump_server: 'major',
      bump_website: 'major',
      should_bump: true,
      publish_cli: true,
      publish_stack: true,
      publish_server: true,
    },
    deployPlan: {
      deploy_ui: { needed: true },
      deploy_server: { needed: true },
      deploy_website: { needed: true },
      deploy_docs: { needed: true },
    },
  });

  for (const [k, v] of Object.entries(plan)) {
    if (k.startsWith('docker')) continue;
    assert.equal(v, false, `expected ${k} to be false in dry-run mode`);
  }
});

