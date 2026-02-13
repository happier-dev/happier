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
    ['build-tauri.yml', 'build', 'release-shared'],
    ['publish-github-release.yml', 'publish', 'release-shared'],
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

test('secret-bearing workflows require release-admin actor guard before privileged jobs', async () => {
  const { raw: guardRaw, parsed: guardParsed } = await loadWorkflow('release-actor-guard.yml');

  assert.ok(guardParsed?.on?.workflow_call, 'release-actor-guard must be reusable via workflow_call');
  assert.equal(
    guardParsed?.on?.workflow_call?.inputs?.guard_environment?.default,
    'release-shared',
    'release-actor-guard should default to release-shared environment for app credentials'
  );
  assert.equal(
    guardParsed?.jobs?.authorize?.environment,
    '${{ inputs.guard_environment }}',
    'release-actor-guard should load app credentials from the configured environment'
  );
  assert.match(
    guardRaw,
    /secrets\.RELEASE_BOT_APP_ID/,
    'release-actor-guard should use RELEASE_BOT_APP_ID from environment-scoped secrets'
  );
  assert.match(
    guardRaw,
    /secrets\.RELEASE_BOT_PRIVATE_KEY/,
    'release-actor-guard should use RELEASE_BOT_PRIVATE_KEY from environment-scoped secrets'
  );
  assert.match(
    guardRaw,
    /actions\/create-github-app-token@v1/,
    'release-actor-guard should support GitHub App token checks for team membership'
  );
  assert.match(
    guardRaw,
    /orgs\/\$\{ORG\}\/teams\/\$\{TEAM_SLUG\}\/memberships\/\$\{ACTOR\}/,
    'release-actor-guard should verify actor membership in the configured team via the GitHub API'
  );
  assert.match(
    guardRaw,
    /collaborators\/\$\{ACTOR\}\/permission/,
    'release-actor-guard should support repo-admin fallback authorization checks'
  );
  assert.match(
    guardRaw,
    /GITHUB_TRIGGERING_ACTOR/,
    'release-actor-guard should prefer triggering actor for reruns'
  );
  assert.match(
    guardRaw,
    /401\|403|Unexpected response/,
    'release-actor-guard should fail closed on authorization or unexpected API responses'
  );

  const guardJob = 'release_actor_guard';
  const expectedWiring = [
    ['release.yml', 'gate'],
    ['release.yml', 'providers_gate'],
    ['release-npm.yml', 'release'],
    ['promote-ui.yml', 'promote'],
    ['promote-server.yml', 'promote'],
    ['promote-website.yml', 'promote'],
    ['promote-docs.yml', 'promote'],
    ['promote-branch.yml', 'promote'],
    ['build-tauri.yml', 'resolve_source'],
    ['publish-github-release.yml', 'publish'],
    ['providers-contracts.yml', 'trusted_ref_guard'],
    ['deploy.yml', 'deploy'],
    ['tests.yml', 'providers'],
  ];

  const needsInclude = (needs, name) => {
    if (Array.isArray(needs)) return needs.includes(name);
    if (typeof needs === 'string') return needs === name;
    return false;
  };

  for (const [file, jobName] of expectedWiring) {
    const { parsed } = await loadWorkflow(file);
    const guard = parsed?.jobs?.[guardJob];
    assert.ok(guard, `${file} should define '${guardJob}'`);
    if (guard?.uses) {
      assert.equal(
        guard?.uses,
        './.github/workflows/release-actor-guard.yml',
        `${file} should use the canonical release-actor-guard reusable workflow`
      );
    } else {
      assert.equal(
        guard?.environment,
        undefined,
        `${file} '${guardJob}' should not request release-shared environment secrets`
      );
      assert.ok(
        Array.isArray(guard?.steps),
        `${file} '${guardJob}' should be implemented as a normal job with steps`
      );
      const guardStep = guard.steps.find(
        (step) => step?.uses === './.github/actions/release-actor-guard'
      );
      assert.ok(
        guardStep,
        `${file} '${guardJob}' should use the composite release-actor-guard action`
      );
      assert.equal(
        guardStep?.with?.app_id,
        undefined,
        `${file} '${guardJob}' should not pass app_id secrets to the guard action`
      );
      assert.equal(
        guardStep?.with?.private_key,
        undefined,
        `${file} '${guardJob}' should not pass private_key secrets to the guard action`
      );
    }

    const job = parsed?.jobs?.[jobName];
    assert.ok(job, `${file} should define job '${jobName}'`);
    assert.ok(
      needsInclude(job?.needs, guardJob),
      `${file} job '${jobName}' should require '${guardJob}'`
    );
    assert.equal(
      guard?.secrets,
      undefined,
      `${file} should not pass app secrets directly to release_actor_guard`
    );
  }
});
