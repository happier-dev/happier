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
  assert.ok(Object.keys(inputs).length <= 10, 'workflow_dispatch inputs must stay <= 10');
});

test('release workflow uses compact grouped inputs', async () => {
  const { parsed } = await loadWorkflow();
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  for (const key of ['checks_profile', 'deploy_targets', 'force_deploy', 'ui_expo_action', 'desktop_mode', 'bump', 'confirm', 'release_message']) {
    assert.ok(inputs[key], `expected grouped input ${key}`);
  }

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
  ]) {
    assert.equal(inputs[legacyKey], undefined, `workflow_dispatch input ${legacyKey} should be removed from the compact manual surface`);
  }
});

test('release workflow derives promote mode from confirm and uses compact defaults for advanced options', async () => {
  const { raw } = await loadWorkflow();

  assert.match(raw, /confirm="\$\{\{ inputs\.confirm \}\}"/, 'confirm should be read as the only promotion selector');
  assert.doesNotMatch(raw, /inputs\.promote_mode/, 'workflow should not read promote_mode input anymore');

  assert.doesNotMatch(raw, /inputs\.custom_checks/, 'manual release workflow should not expose custom check toggles');
  assert.doesNotMatch(raw, /inputs\.run_providers/, 'manual release workflow should not wire provider checks directly');
  assert.doesNotMatch(raw, /inputs\.providers_preset/, 'manual release workflow should not expose provider preset');
  assert.doesNotMatch(raw, /inputs\.providers_tier/, 'manual release workflow should not expose provider tier');

  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',ui,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',server,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',website,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',docs,'\)/);

  assert.match(raw, /desktop_build:\s*\$\{\{ inputs\.desktop_mode != 'none' \}\}/);
  assert.match(raw, /desktop_publish_release:\s*\$\{\{ inputs\.desktop_mode == 'build_and_publish' \}\}/);
  assert.match(raw, /expo_builder:\s*eas_cloud/);
  assert.match(raw, /expo_profile:\s*auto/);
  assert.match(raw, /expo_platform:\s*all/);
  assert.doesNotMatch(raw, /inputs\.bump_app_override/);
  assert.doesNotMatch(raw, /inputs\.bump_cli_override/);
  assert.doesNotMatch(raw, /inputs\.bump_stack_override/);
});
