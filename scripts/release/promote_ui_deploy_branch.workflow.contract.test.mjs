import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('promote-ui keeps workflow_dispatch inputs under GitHub limit with compact manual controls', async () => {
  const raw = await loadWorkflow('promote-ui.yml');
  const parsed = parse(raw);
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  assert.ok(Object.keys(inputs).length <= 10, 'workflow_dispatch inputs must stay <= 10');

  for (const key of [
    'environment',
    'force_deploy',
    'run_tests',
    'source_ref',
    'allow_cross_promote',
    'bump',
    'deploy_web',
    'expo_action',
    'expo_update_message',
    'desktop_mode',
  ]) {
    assert.ok(inputs[key], `expected compact manual input ${key}`);
  }

  for (const legacyKey of ['expo_builder', 'expo_profile', 'expo_platform', 'desktop_build', 'desktop_publish_release']) {
    assert.equal(inputs[legacyKey], undefined, `manual input ${legacyKey} should be removed from workflow_dispatch`);
  }
});

test('promote-ui delegates web deploy branch promotion to pipeline script', async () => {
  const raw = await loadWorkflow('promote-ui.yml');
  assert.match(raw, /Promote source ref to deploy branch \(web\)/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs promote-deploy-branch/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs deploy/);
  assert.doesNotMatch(raw, /steps\.deploy_meta\.outputs\./, 'promote-ui should not reference outputs from a nonexistent deploy_meta step');
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);
});
