import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow defaults installer smoke to the dev lane on non-main branch pushes while preserving preview for explicit requests', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  assert.match(raw, /installers_channel:/, 'tests.yml should expose installers_channel input');
  assert.match(raw, /installers_source:/, 'tests.yml should expose an exact installer source input');
  assert.match(raw, /installers_ref:/, 'tests.yml should expose an exact installer ref input');
  assert.match(raw, /node scripts\/pipeline\/run\.mjs release-validate/, 'tests.yml should delegate installer smoke to release-validate');
  assert.match(raw, /--suite installers-smoke/, 'tests.yml should run the installer smoke suite');
  assert.match(raw, /INSTALLERS_SOURCE:/, 'tests.yml should route installer source selection through env');
  assert.match(raw, /INSTALLERS_REF:/, 'tests.yml should route installer refs through env');
  assert.match(raw, /INSTALLERS_RELEASE_CHANNEL:/, 'tests.yml should route installer release channels through env');
  assert.match(raw, /--source "\$\{INSTALLERS_SOURCE\}"|--source "\$env:INSTALLERS_SOURCE"/, 'tests.yml should pass the resolved installer source into release-validate');
  assert.match(raw, /--ref "\$\{INSTALLERS_REF\}"|--ref "\$env:INSTALLERS_REF"/, 'tests.yml should pass the resolved installer ref into release-validate');
  assert.match(raw, /--release-channel "\$\{INSTALLERS_RELEASE_CHANNEL\}"|--release-channel "\$env:INSTALLERS_RELEASE_CHANNEL"/, 'tests.yml should pass the resolved installer release channel into release-validate');
  const expectedChannel = "${{ inputs.select_jobs_explicitly && inputs.installers_channel || ((github.event_name == 'push' && github.ref_name == 'main') || (github.event_name == 'pull_request' && github.base_ref == 'main')) && 'stable' || 'dev' }}";
  for (const jobName of ['installers-smoke-linux', 'installers-smoke-macos', 'installers-smoke-windows']) {
    assert.equal(
      workflow.jobs[jobName].env.INSTALLERS_CHANNEL,
      expectedChannel,
      `${jobName} should honor explicit reusable input and otherwise default to stable only on main`,
    );
  }
  assert.match(raw, /inputs\.installers_source/);
  assert.match(raw, /inputs\.installers_ref != '' && inputs\.installers_ref/);
  assert.doesNotMatch(raw, /cli-preview/, 'tests.yml should not own rolling release tag names directly');
  assert.doesNotMatch(raw, /install-preview\.(sh|ps1)/, 'tests.yml should not own installer filename selection directly');
});
