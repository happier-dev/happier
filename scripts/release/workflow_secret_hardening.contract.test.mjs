import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { readdir } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: parse(raw) };
}

test('release workflows scope shared signing/publishing secrets to release-shared environment', async () => {
  const checks = [
    ['release-npm.yml', 'publish-cli', 'release-shared'],
    ['release-npm.yml', 'publish-stack', 'release-shared'],
    ['release-npm.yml', 'publish-server-runner', 'release-shared'],
    ['promote-ui.yml', 'promote', 'release-shared'],
    ['promote-server.yml', 'promote', 'release-shared'],
    ['promote-website.yml', 'promote', 'release-shared'],
    ['promote-docs.yml', 'promote', 'release-shared'],
    ['promote-branch.yml', 'promote', 'release-shared'],
    ['build-tauri.yml', 'finalize', 'release-shared'],
    ['publish-github-release.yml', 'publish', 'release-shared'],
  ];

  for (const [file, job, expected] of checks) {
    const { parsed } = await loadWorkflow(file);
    const actual = parsed?.jobs?.[job]?.environment;
    assert.equal(actual, expected, `${file} job '${job}' should use environment '${expected}'`);
  }
});

test('Tauri release guard executes trusted workflow control bytes before using App credentials', async () => {
  const { parsed } = await loadWorkflow('build-tauri.yml');
  const guard = parsed?.jobs?.release_actor_guard;
  const build = parsed?.jobs?.build;
  const finalize = parsed?.jobs?.finalize;

  assert.equal(build?.environment, undefined, 'candidate build must not request release-shared secrets');
  assert.equal(finalize?.environment, 'release-shared', 'trusted finalization owns release-shared secrets');

  const checkoutSteps = guard?.steps?.filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262') ?? [];
  assert.equal(checkoutSteps.length, 1, 'release actor guard must have exactly one checkout');
  const checkout = checkoutSteps[0];
  assert.equal(checkout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout?.with?.['persist-credentials'], false);

  const checkoutIndex = guard.steps.indexOf(checkout);
  const authorizationIndex = guard.steps.findIndex(
    (step) => step?.uses === './.github/actions/release-actor-guard'
  );
  assert.ok(checkoutIndex >= 0 && checkoutIndex < authorizationIndex, 'trusted checkout must precede authorization');
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

test('release workflow keeps provider checks outside the compact manual release surface', async () => {
  const { parsed } = await loadWorkflow('release.yml');
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  assert.equal(inputs?.run_providers, undefined, 'compact manual release workflow should not expose provider toggles');
  assert.equal(inputs?.providers_preset, undefined, 'compact manual release workflow should not expose provider presets');
  assert.equal(inputs?.providers_tier, undefined, 'compact manual release workflow should not expose provider tiers');

  const ciJob = parsed?.jobs?.ci;
  assert.ok(ciJob, 'ci job should exist');
  assert.equal(ciJob.secrets, undefined, 'ci should not inherit secrets');
  assert.doesNotMatch(JSON.stringify(ciJob), /run_providers|providers_preset|providers_tier/, 'ci should never run providers directly');
  assert.equal(parsed?.jobs?.providers, undefined, 'release.yml should not embed a separate providers job; provider contracts run from their dedicated workflow');
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
      /Untrusted .*workflow control ref|Untrusted release workflow ref|Untrusted workflow_dispatch ref|trusted refs for manual dispatch|Refusing workflow_dispatch from untrusted ref/,
      `${file} should contain an explicit trusted-ref guard for workflow_dispatch`
    );
  }
});

test('release actor credentials are unavailable until secret-free workflow-ref admission succeeds', async () => {
  const files = [
    'build-tauri.yml',
    'build-ui-mobile-local.yml',
    'deploy-on-deploy-branch.yml',
    'deploy.yml',
    'promote-branch.yml',
    'promote-docs.yml',
    'promote-server.yml',
    'promote-ui.yml',
    'promote-website.yml',
    'providers-contracts.yml',
    'publish-cli-binaries.yml',
    'publish-docker.yml',
    'publish-github-release.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
    'publish-ui-mobile-dev.yml',
    'publish-ui-web.yml',
    'release-npm.yml',
    'release.yml',
    'tests.yml',
  ];

  for (const file of files) {
    const { parsed } = await loadWorkflow(file);
    const admission = parsed?.jobs?.trusted_ref_guard;
    const actorGuard = parsed?.jobs?.release_actor_guard;
    assert.ok(admission, `${file} should define a secret-free trusted_ref_guard`);
    assert.ok(actorGuard, `${file} should define release_actor_guard`);
    assert.equal(admission.environment, undefined, `${file} trusted_ref_guard must not request an environment`);
    assert.doesNotMatch(JSON.stringify(admission), /secrets\./, `${file} trusted_ref_guard must not consume secrets`);
    assert.match(JSON.stringify(admission), /job\.workflow_ref/, `${file} trusted_ref_guard must admit the exact workflow ref`);
    const needs = Array.isArray(actorGuard.needs) ? actorGuard.needs : [actorGuard.needs];
    assert.ok(needs.includes('trusted_ref_guard'), `${file} release_actor_guard must depend on trusted_ref_guard`);

    const checkout = actorGuard.steps?.find(
      (step) => String(step?.uses ?? '').startsWith('actions/checkout@'),
    );
    assert.ok(checkout, `${file} release_actor_guard must check out trusted control bytes`);
    assert.equal(checkout.with?.repository, '${{ job.workflow_repository }}', `${file} trusted repository`);
    assert.equal(checkout.with?.ref, '${{ job.workflow_sha }}', `${file} trusted ref`);
    assert.equal(checkout.with?.['persist-credentials'], false, `${file} checkout credentials`);
  }
});

test('workflows never use the nonexistent github.workflow_repository trust selector', async () => {
  const workflowDir = join(repoRoot, '.github', 'workflows');
  const files = (await readdir(workflowDir)).filter((name) => name.endsWith('.yml'));
  for (const file of files) {
    const { raw } = await loadWorkflow(file);
    assert.doesNotMatch(raw, /github\.workflow_repository/, `${file} must use job.workflow_repository`);
  }
});

test('external actions in privileged jobs are pinned to immutable commits', async () => {
  const workflowDir = join(repoRoot, '.github', 'workflows');
  const files = (await readdir(workflowDir)).filter((name) => name.endsWith('.yml'));
  for (const file of files) {
    const { parsed } = await loadWorkflow(file);
    for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
      const effectivePermissions = job?.permissions ?? parsed?.permissions ?? {};
      const hasWritePermission = Object.values(effectivePermissions).some((value) => value === 'write');
      const serialized = JSON.stringify(job);
      const privileged = hasWritePermission || job?.environment !== undefined || /secrets\./.test(serialized) || job?.secrets === 'inherit';
      if (!privileged) continue;
      for (const step of job?.steps ?? []) {
        const uses = typeof step?.uses === 'string' ? step.uses : '';
        if (!uses || uses.startsWith('./')) continue;
        assert.match(uses, /@[0-9a-f]{40}$/u, `${basename(file)} ${jobName}/${step.name ?? uses} must pin ${uses} to a full commit`);
      }
    }
  }
});

test('secret-bearing workflows require release-admin actor guard before privileged jobs', async () => {
  const { raw: deployRaw } = await loadWorkflow('deploy.yml');
  assert.doesNotMatch(
    deployRaw,
    /\n\s*push:\s*\n/,
    'deploy workflow must not deploy on push (promote workflows trigger webhooks directly)'
  );

  const guardJob = 'release_actor_guard';
  const expectedWiring = [
    ['release.yml', 'ci'],
    ['release-npm.yml', 'release'],
    ['promote-ui.yml', 'promote'],
    ['promote-server.yml', 'promote'],
    ['promote-website.yml', 'promote'],
    ['promote-docs.yml', 'promote'],
    ['promote-branch.yml', 'promote'],
    ['build-tauri.yml', 'resolve_source'],
    ['publish-github-release.yml', 'publish'],
    ['providers-contracts.yml', 'providers'],
    ['deploy.yml', 'deploy'],
    ['tests.yml', 'providers'],
  ];

  const transitivelyNeeds = (jobs, jobName, dependency, seen = new Set()) => {
    if (seen.has(jobName)) return false;
    seen.add(jobName);
    const rawNeeds = jobs?.[jobName]?.needs;
    const needs = Array.isArray(rawNeeds) ? rawNeeds : typeof rawNeeds === 'string' ? [rawNeeds] : [];
    return needs.some((needed) => needed === dependency || transitivelyNeeds(jobs, needed, dependency, seen));
  };

  for (const [file, jobName] of expectedWiring) {
    const { parsed } = await loadWorkflow(file);
    const guard = parsed?.jobs?.[guardJob];
    assert.ok(guard, `${file} should define '${guardJob}'`);
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
    assert.match(
      String(guardStep?.with?.app_id ?? ''),
      /secrets\.RELEASE_BOT_APP_ID/,
      `${file} '${guardJob}' should pass RELEASE_BOT_APP_ID to the guard action`
    );
    assert.match(
      String(guardStep?.with?.private_key ?? ''),
      /secrets\.RELEASE_BOT_PRIVATE_KEY/,
      `${file} '${guardJob}' should pass RELEASE_BOT_PRIVATE_KEY to the guard action`
    );

    const job = parsed?.jobs?.[jobName];
    assert.ok(job, `${file} should define job '${jobName}'`);
    assert.ok(
      transitivelyNeeds(parsed.jobs, jobName, guardJob),
      `${file} job '${jobName}' should require '${guardJob}'`
    );
    assert.equal(
      guard?.secrets,
      undefined,
      `${file} should not pass app secrets directly to release_actor_guard`
    );
  }
});
