import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowPath = join(repoRoot, '.github', 'workflows', 'release.yml');

async function loadWorkflow() {
  const raw = await readFile(workflowPath, 'utf8');
  return { raw, parsed: parse(raw) };
}

test('release workflow keeps workflow_dispatch inputs under GitHub limit', async () => {
  const { parsed } = await loadWorkflow();
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};
  assert.ok(Object.keys(inputs).length <= 25, 'workflow_dispatch inputs must stay <= 25');
});

test('release workflow uses compact grouped inputs', async () => {
  const { parsed } = await loadWorkflow();
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  for (const key of ['validation_profile', 'deploy_targets', 'force_deploy', 'ui_expo_action', 'desktop_mode', 'confirm', 'authorized_promotion_source_sha', 'workflow_control_sha', 'public_sdk_release_approval']) {
    assert.ok(inputs[key], `expected grouped input ${key}`);
  }

  assert.equal(inputs.checks_profile, undefined, 'the public release profile owns its checks mapping');
  assert.deepEqual(inputs.validation_profile.options, ['integrated', 'stable']);
  assert.equal(inputs.validation_profile.default, 'integrated');
  assert.equal(inputs.release_message, undefined, 'release notes come from the exact candidate changelog projection');
  assert.equal(inputs.public_sdk_release_approval.type, 'string');
  assert.equal(inputs.public_sdk_release_approval.default, '{}');

  for (const legacyKey of [
    'custom_checks',
    'run_providers',
    'providers_preset',
    'providers_tier',
    'release_verify_profile',
    'ui_expo_builder',
    'ui_expo_profile',
    'ui_expo_platform',
    'bump_app_override',
    'bump_cli_override',
    'bump_stack_override',
    'plugin_sdk_ready',
    'plugin_sdk_api_classification',
    'plugin_sdk_migration_notes',
    'sdk_auth_readiness',
    'sdk_auth_waiver',
    'sdk_api_classification',
    'sdk_migration_notes',
  ]) {
    assert.equal(inputs[legacyKey], undefined, `workflow_dispatch input ${legacyKey} should be removed from the compact manual surface`);
  }

  const dispatch = parsed.jobs.ci.steps.find((step) => step?.id === 'dispatch');
  assert.equal(dispatch.env.PUBLIC_SDK_RELEASE_APPROVAL, '${{ inputs.public_sdk_release_approval }}');
  assert.equal(parsed.jobs.ci.outputs.sdk_auth_readiness, '${{ steps.dispatch.outputs.sdk_auth_readiness }}');
  assert.equal(
    parsed.jobs.release_admission.steps.at(-1).env.SDK_AUTH_READINESS,
    '${{ needs.ci.outputs.sdk_auth_readiness }}',
  );
});

test('release workflow resolves the public profile internally before CI and planning', async () => {
  const { raw, parsed } = await loadWorkflow();
  const resolver = parsed.jobs.resolve_validation_profile;
  const resolverStep = resolver?.steps?.find((step) => step?.id === 'resolve');

  assert.ok(resolver, 'workflow dispatch must resolve profile ownership before callers can schedule checks');
  assert.deepEqual(resolver.needs, ['release_actor_guard']);
  assert.equal(resolver.outputs.profile, '${{ steps.resolve.outputs.profile }}');
  assert.equal(resolver.outputs.checks_profile, '${{ steps.resolve.outputs.checks_profile }}');
  assert.equal(resolverStep?.env?.VALIDATION_PROFILE, '${{ inputs.validation_profile }}');
  assert.match(
    resolverStep?.run ?? '',
    /node scripts\/pipeline\/release-validation\/resolve-profile\.mjs "\$VALIDATION_PROFILE"/,
  );
  assert.doesNotMatch(resolverStep?.run ?? '', /CHECKS_PROFILE/);

  assert.deepEqual(parsed.jobs.ci.needs, ['resolve_validation_profile']);
  assert.equal(parsed.jobs.ci.if, "${{ needs.resolve_validation_profile.result == 'success' }}");
  assert.ok(parsed.jobs.plan.needs.includes('resolve_validation_profile'));
  assert.equal(parsed.jobs.plan.outputs.validation_profile, '${{ needs.resolve_validation_profile.outputs.profile }}');
  assert.equal(parsed.jobs.plan.outputs.checks_profile, '${{ needs.resolve_validation_profile.outputs.checks_profile }}');
  assert.doesNotMatch(raw, /inputs\.checks_profile/, 'no workflow path may retain a caller-selected checks profile');
});

test('release workflow derives promotion inputs from confirm and uses compact defaults for advanced options', async () => {
  const { raw, parsed } = await loadWorkflow();
  const promoteMain = parsed.jobs.promote_main;

  assert.match(raw, /CONFIRM:\s*\$\{\{ inputs\.confirm \}\}/, 'confirm should cross the workflow boundary as environment data');
  assert.match(promoteMain.with.source, /inputs\.confirm/, 'confirm should select the production source branch');
  assert.match(promoteMain.with.mode, /inputs\.confirm/, 'confirm should select the production promotion mode');
  assert.match(promoteMain.with.confirm, /inputs\.confirm/, 'confirm should select the promotion confirmation text');
  assert.doesNotMatch(raw, /confirm="\$\{\{ inputs\.confirm \}\}"/, 'workflow input must not be interpolated into shell source');
  assert.doesNotMatch(raw, /inputs\.promote_mode/, 'workflow should not read promote_mode input anymore');

  assert.doesNotMatch(raw, /inputs\.custom_checks/, 'manual release workflow should not expose custom check toggles');
  assert.doesNotMatch(raw, /inputs\.run_providers/, 'manual release workflow should not wire provider checks directly');
  assert.doesNotMatch(raw, /inputs\.providers_preset/, 'manual release workflow should not expose provider preset');
  assert.doesNotMatch(raw, /inputs\.providers_tier/, 'manual release workflow should not expose provider tier');

  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',ui,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',server,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',website,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',docs,'\)/);

  assert.match(raw, /desktop_mode:\s*\$\{\{\s*inputs\.desktop_mode\s*\}\}/);
  assert.doesNotMatch(raw, /desktop_build:\s*\$\{\{ inputs\.desktop_mode != 'none' \}\}/);
  assert.doesNotMatch(raw, /desktop_publish_release:\s*\$\{\{ inputs\.desktop_mode == 'build_and_publish' \}\}/);
  assert.doesNotMatch(raw, /expo_builder:\s*eas_cloud/);
  assert.doesNotMatch(raw, /expo_profile:\s*auto/);
  assert.doesNotMatch(raw, /expo_platform:\s*all/);
  assert.doesNotMatch(raw, /inputs\.bump_app_override/);
  assert.doesNotMatch(raw, /inputs\.bump_cli_override/);
  assert.doesNotMatch(raw, /inputs\.bump_stack_override/);
});
