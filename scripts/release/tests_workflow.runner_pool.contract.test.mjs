import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = new URL('../..', import.meta.url).pathname;

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return YAML.parse(raw, { prettyErrors: true });
}

test('manual test dispatch can opt proven Linux lanes into Blacksmith without changing ordinary CI', async () => {
  const dispatch = await loadWorkflow('tests-dispatch.yml');
  const tests = await loadWorkflow('tests.yml');

  assert.deepEqual(dispatch.on.workflow_dispatch.inputs.runner_pool, {
    description: 'Runner pool — GitHub is the default; Blacksmith accelerates proven Linux test lanes',
    required: true,
    default: 'github',
    type: 'choice',
    options: ['github', 'blacksmith-linux-4vcpu'],
  });
  assert.deepEqual(tests.on.workflow_call.inputs.runner_pool, {
    description: 'Runner pool for proven-portable Linux test lanes',
    required: false,
    default: 'github',
    type: 'string',
  });
  assert.equal(dispatch.jobs.tests.with.runner_pool, '${{ inputs.runner_pool }}');

  const ubuntu2204 = "${{ inputs.runner_pool == 'blacksmith-linux-4vcpu' && 'blacksmith-4vcpu-ubuntu-2204' || 'ubuntu-22.04' }}";
  const ubuntu2404 = "${{ inputs.runner_pool == 'blacksmith-linux-4vcpu' && 'blacksmith-4vcpu-ubuntu-2404' || 'ubuntu-latest' }}";

  for (const jobName of [
    'ui-e2e',
    'mobile-e2e-android',
    'ui-unit',
    'ui-integration',
    'shared-packages-unit',
    'plugin-workspaces-unit',
    'server-db-contract',
    'cli',
    'e2e-core',
    'e2e-core-slow',
    'plugin-platform-packed',
  ]) {
    assert.equal(tests.jobs[jobName]['runs-on'], ubuntu2204, `${jobName} should use the selected Ubuntu 22.04 runner pool`);
  }

  for (const jobName of [
    'server',
    'installers-smoke-linux',
    'binary-smoke',
    'typecheck',
    'cli-daemon-e2e',
  ]) {
    assert.equal(tests.jobs[jobName]['runs-on'], ubuntu2404, `${jobName} should use the selected Ubuntu 24.04 runner pool`);
  }

  const cliProxyLinux = tests.jobs['cliproxyapi-managed-runtime'].strategy.matrix.include.find((entry) => entry.platform_key === 'linux-amd64');
  assert.equal(cliProxyLinux.runner, ubuntu2404, 'the CLIProxyAPI Linux build should use the selected runner pool');

  assert.equal(tests.jobs.ui['runs-on'], 'ubuntu-22.04', 'the tiny UI result aggregator should not consume accelerated minutes');
  assert.equal(tests.jobs.stack['runs-on'], 'ubuntu-latest', 'the runner-sensitive Stack suite should remain on GitHub initially');
  assert.equal(tests.jobs['release-contracts']['runs-on'], 'ubuntu-latest', 'release control contracts should remain on GitHub');
  assert.equal(tests.jobs['artifact-verify']['runs-on'], 'ubuntu-latest', 'release artifact verification should remain on GitHub');
  for (const jobName of [
    'cli-update-continuity',
    'daemon-continuity',
    'session-continuity',
    'release-assets-docker',
    'self-host-systemd-e2e',
    'stress',
  ]) {
    assert.equal(tests.jobs[jobName]['runs-on'], 'ubuntu-latest', `${jobName} should remain on GitHub initially`);
  }
  assert.equal(tests.jobs.trusted_ref_guard['runs-on'], 'ubuntu-latest', 'trusted-ref admission must happen before third-party runners');
  assert.equal(tests.jobs.release_actor_guard['runs-on'], 'ubuntu-latest', 'release actor authorization must stay on GitHub');
  assert.equal(tests.jobs.providers['runs-on'], 'ubuntu-latest', 'secret-bearing provider contracts should remain on GitHub initially');
  assert.equal(tests.jobs['installers-smoke-macos']['runs-on'], 'macos-latest');
  assert.equal(tests.jobs['installers-smoke-windows']['runs-on'], 'windows-latest');
  assert.deepEqual(tests.jobs['ui-e2e-wsrepl-lima']['runs-on'], ['self-hosted', 'macOS', 'wsrepl-lima']);
});
