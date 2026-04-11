import test from 'node:test';
import assert from 'node:assert/strict';

import { computeReleaseExecutionPlan } from '../../scripts/pipeline/release/lib/release-orchestrator.mjs';

test('preview: cli-stack shared changes publish docker dev-box even without direct cli or stack path changes', () => {
  const plan = computeReleaseExecutionPlan({
    environment: 'preview',
    dryRun: false,
    forceDeploy: false,
    deployTargets: ['cli', 'stack'],
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
      changed_cli_stack_shared: true,
    },
    bumpPlan: {
      bump_app: 'none',
      bump_cli: 'patch',
      bump_stack: 'patch',
      bump_server: 'none',
      bump_website: 'none',
      should_bump: true,
      publish_cli: true,
      publish_stack: true,
      publish_server: false,
    },
    deployPlan: null,
  });

  assert.equal(plan.runPublishDocker, true);
  assert.equal(plan.dockerBuildDevBox, true);
  assert.equal(plan.dockerBuildRelay, false);
});
