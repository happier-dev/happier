import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

const workflowPath = new URL('../../.github/workflows/release.yml', import.meta.url);

async function loadWorkflow() {
  return YAML.parse(await readFile(workflowPath, 'utf8'));
}

test('release coordinator carries public SDK package decisions, risk facts, and verified identities through the npm release owner', async () => {
  const workflow = await loadWorkflow();
  const plan = workflow.jobs?.plan;
  assert.match(String(plan?.outputs?.publish_plugin_sdk ?? ''), /steps\.bump_plan\.outputs\.publish_plugin_sdk/);
  assert.match(String(plan?.outputs?.publish_sdk ?? ''), /steps\.bump_plan\.outputs\.publish_sdk/);
  assert.match(String(plan?.outputs?.risk_plugin_sdk_package_changed ?? ''), /steps\.plan\.outputs\.risk_plugin_sdk_package_changed/);
  assert.match(String(plan?.outputs?.risk_plugin_runtime_compatibility ?? ''), /steps\.plan\.outputs\.risk_plugin_runtime_compatibility/);

  const bumpPlan = plan?.steps?.find((step) => step.id === 'bump_plan');
  assert.match(String(bumpPlan?.run ?? ''), /--changed-plugin-sdk "\$\{CHANGED_PLUGIN_SDK\}"/);
  assert.match(String(bumpPlan?.run ?? ''), /--versioned-plugin-sdk-changed "\$\{VERSIONED_PLUGIN_SDK_CHANGED\}"/);
  assert.match(String(bumpPlan?.run ?? ''), /--changed-sdk "\$\{CHANGED_SDK\}"/);
  assert.match(String(bumpPlan?.run ?? ''), /--versioned-sdk-changed "\$\{VERSIONED_SDK_CHANGED\}"/);

  const publishNpm = workflow.jobs?.publish_npm;
  assert.match(String(publishNpm?.if ?? ''), /publish_plugin_sdk/);
  assert.match(String(publishNpm?.if ?? ''), /publish_sdk/);
  assert.equal(publishNpm?.with?.publish_plugin_sdk, "${{ needs.plan.outputs.publish_plugin_sdk == 'true' }}");
  assert.equal(publishNpm?.with?.publish_sdk, "${{ needs.plan.outputs.publish_sdk == 'true' }}");
  // The npm publisher consumes the versions the plan already admitted; it must
  // not allocate a different publication identity at publish time.
  assert.equal(publishNpm?.with?.plugin_sdk_version, '${{ needs.plan.outputs.plugin_sdk_version }}');
  assert.equal(publishNpm?.with?.sdk_version, '${{ needs.plan.outputs.sdk_version }}');
  assert.equal(
    publishNpm?.with?.release_message,
    undefined,
    'release notes stay owned by the release-notes projection owners, not the npm publisher',
  );

  const statusFacts = workflow.jobs?.release_status?.steps?.find((step) => step.name === 'Project release status facts');
  assert.equal(statusFacts?.env?.REQUEST_PLUGIN_SDK, "${{ needs.plan.outputs.publish_plugin_sdk == 'true' }}");
  assert.equal(statusFacts?.env?.REQUEST_SDK, "${{ needs.plan.outputs.publish_sdk == 'true' }}");
  assert.match(String(statusFacts?.env?.NPM_PLUGIN_SDK_INTEGRITY ?? ''), /needs\.publish_npm\.outputs\.plugin_sdk_integrity/);
  assert.match(String(statusFacts?.env?.NPM_PLUGIN_UI_INTEGRITY ?? ''), /needs\.publish_npm\.outputs\.plugin_ui_integrity/);
  assert.match(String(statusFacts?.env?.NPM_SDK_INTEGRITY ?? ''), /needs\.publish_npm\.outputs\.sdk_integrity/);
});
