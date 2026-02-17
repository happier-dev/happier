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

  for (const key of ['custom_checks', 'deploy_targets', 'desktop_mode', 'bump_app_override', 'bump_cli_override', 'bump_stack_override', 'release_verify_profile']) {
    assert.ok(inputs[key], `expected grouped input ${key}`);
  }

  for (const legacyKey of [
    'promote_mode',
    'run_e2e_core',
    'run_server_db_contract',
    'run_stress',
    'cli_smoke_linux',
    'run_self_host_systemd',
    'build_website',
    'build_docs',
    'deploy_ui',
    'deploy_server',
    'deploy_website',
    'deploy_docs',
    'desktop_build',
    'desktop_publish_release',
    'cli_bump',
    'stack_bump',
  ]) {
    assert.equal(inputs[legacyKey], undefined, `legacy input ${legacyKey} should be removed`);
  }
});

test('release workflow derives promote mode from confirm and uses grouped toggles', async () => {
  const { raw } = await loadWorkflow();

  assert.match(raw, /confirm="\$\{\{ inputs\.confirm \}\}"/, 'confirm should be read as the only promotion selector');
  assert.doesNotMatch(raw, /inputs\.promote_mode/, 'workflow should not read promote_mode input anymore');

  assert.match(
    raw,
    /inputs\.checks_profile == 'custom' && \(contains\(format\(',\{0\},', inputs\.custom_checks\), ',e2e_core,'\)\s+\|\|\s+contains\(format\(',\{0\},', inputs\.custom_checks\), ',e2e_core_slow,'\)\)/,
  );
  assert.match(raw, /inputs\.checks_profile == 'custom' && contains\(format\(',\{0\},', inputs\.custom_checks\), ',e2e_core_slow,'\)/);
  assert.match(raw, /inputs\.checks_profile == 'custom' && contains\(format\(',\{0\},', inputs\.custom_checks\), ',server_db_contract,'\)/);
  assert.match(raw, /inputs\.checks_profile == 'custom' && contains\(format\(',\{0\},', inputs\.custom_checks\), ',build_website,'\)/);
  assert.match(raw, /inputs\.checks_profile == 'custom' && contains\(format\(',\{0\},', inputs\.custom_checks\), ',build_docs,'\)/);
  assert.match(raw, /inputs\.checks_profile == 'custom' && contains\(format\(',\{0\},', inputs\.custom_checks\), ',cli_smoke_linux,'\)/);
  assert.match(raw, /inputs\.checks_profile == 'custom' && contains\(format\(',\{0\},', inputs\.custom_checks\), ',stress,'\)/);

  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',ui,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',server,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',website,'\)/);
  assert.match(raw, /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',docs,'\)/);

  assert.match(raw, /desktop_build:\s*\$\{\{ inputs\.desktop_mode != 'none' \}\}/);
  assert.match(raw, /desktop_publish_release:\s*\$\{\{ inputs\.desktop_mode == 'build_and_publish' \}\}/);
  assert.match(raw, /inputs\.bump_cli_override/);
  assert.match(raw, /inputs\.bump_stack_override/);
  assert.doesNotMatch(raw, /inputs\.cli_bump/);
  assert.doesNotMatch(raw, /inputs\.stack_bump/);
});
