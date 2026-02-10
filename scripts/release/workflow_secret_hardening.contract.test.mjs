import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: parse(raw) };
}

test('release workflows scope shared signing/publishing secrets to release-shared environment', async () => {
  const checks = [
    ['release-npm.yml', 'release', 'release-shared'],
    ['promote-ui.yml', 'promote', 'release-shared'],
    ['promote-server.yml', 'promote', 'release-shared'],
    ['promote-website.yml', 'promote', 'release-shared'],
    ['promote-docs.yml', 'promote', 'release-shared'],
    ['promote-branch.yml', 'promote', 'release-shared'],
    ['reset-branch.yml', 'reset', 'release-shared'],
    ['build-tauri.yml', 'build', 'release-shared'],
    ['publish-github-release.yml', 'publish', 'release-shared'],
    ['release.yml', 'checks', 'release-shared'],
    ['release.yml', 'deploy_plan', 'release-shared'],
  ];

  for (const [file, job, expected] of checks) {
    const { parsed } = await loadWorkflow(file);
    const actual = parsed?.jobs?.[job]?.environment;
    assert.equal(actual, expected, `${file} job '${job}' should use environment '${expected}'`);
  }
});

test('provider-secret jobs are isolated to providers-ci environment', async () => {
  const testsWorkflow = await loadWorkflow('tests.yml');
  const providersJobEnv = testsWorkflow.parsed?.jobs?.providers?.environment;
  assert.equal(providersJobEnv, 'providers-ci', 'tests.yml providers job should use providers-ci environment');

  const providersContracts = await loadWorkflow('providers-contracts.yml');
  const providersJob = providersContracts.parsed?.jobs?.providers;
  assert.equal(providersJob?.secrets, 'inherit', 'providers-contracts should pass secrets only to providers lane');
});

test('stress workflows do not inherit secrets into reusable tests workflow', async () => {
  const { parsed } = await loadWorkflow('stress-tests.yml');
  assert.equal(parsed?.jobs?.['stress-scheduled']?.secrets, undefined, 'stress-scheduled should not inherit secrets');
  assert.equal(parsed?.jobs?.['stress-manual']?.secrets, undefined, 'stress-manual should not inherit secrets');
});

test('release workflow defaults providers off and isolates provider secret usage', async () => {
  const { parsed } = await loadWorkflow('release.yml');
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  assert.equal(inputs?.run_providers?.default, false, 'run_providers should default to false');

  const gateJob = parsed?.jobs?.gate;
  assert.ok(gateJob, 'gate job should exist');
  assert.equal(gateJob.secrets, undefined, 'gate should not inherit secrets');
  assert.equal(gateJob.with?.run_providers, false, 'gate should never run providers directly');

  const providersGate = parsed?.jobs?.providers_gate;
  assert.ok(providersGate, 'providers_gate job should exist');
  assert.equal(providersGate.uses, './.github/workflows/providers-contracts.yml', 'providers_gate should use providers-contracts workflow');
  assert.equal(providersGate.secrets, 'inherit', 'providers_gate should inherit secrets for provider checks');
});

test('manual secret-bearing workflows enforce trusted refs', async () => {
  const files = [
    'release.yml',
    'release-npm.yml',
    'promote-ui.yml',
    'promote-server.yml',
    'promote-website.yml',
    'promote-docs.yml',
    'promote-branch.yml',
    'promote-main-from-dev.yml',
    'reset-branch.yml',
    'build-tauri.yml',
    'providers-contracts.yml',
    'deploy.yml',
  ];

  for (const file of files) {
    const { raw } = await loadWorkflow(file);
    assert.match(
      raw,
      /Untrusted workflow_dispatch ref|trusted refs for manual dispatch|Refusing workflow_dispatch from untrusted ref/,
      `${file} should contain an explicit trusted-ref guard for workflow_dispatch`
    );
  }
});
