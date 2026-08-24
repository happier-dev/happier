import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const WORKFLOW_CONTROL_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function loadReleaseWorkflow() {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  return parse(raw);
}

function checkoutSteps(job) {
  return job.steps.filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
}

function assertTrustedControlCheckout(step) {
  assert.equal(step?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(step?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(step?.with?.['persist-credentials'], false);
  assert.equal(step?.with?.path, undefined, 'trusted control must remain the workspace root');
}

function assertNoExpressionInterpolationInShell(job, jobName) {
  for (const step of job.steps) {
    if (typeof step?.run !== 'string') continue;
    assert.doesNotMatch(
      step.run,
      /\$\{\{/,
      `${jobName} must pass workflow metadata through env instead of interpolating it into shell`,
    );
  }
}

function dependsTransitivelyOn(workflow, jobName, dependencyName, seen = new Set()) {
  if (jobName === dependencyName) return true;
  if (seen.has(jobName)) return false;
  seen.add(jobName);
  const rawNeeds = workflow.jobs[jobName]?.needs ?? [];
  const needs = Array.isArray(rawNeeds) ? rawNeeds : [rawNeeds];
  return needs.some((need) => dependsTransitivelyOn(workflow, need, dependencyName, seen));
}

function runReleaseInputValidation(env) {
  return spawnSync(process.execPath, [join(repoRoot, 'scripts', 'pipeline', 'release', 'validate-release-dispatch.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTHORIZED_PROMOTION_SOURCE_SHA: '0123456789abcdef0123456789abcdef01234567',
      CANDIDATE_RUN_ID: '',
      CANDIDATE_VERSION: '',
      CANDIDATE_SOURCE_SHA: '',
      RESUME_RUN_ID: '',
      HMAINT_OPERATION_ID: '',
      HMAINT_ATTEMPT_ID: 'attempt_1',
      RELEASE_NOTES_ID: 'release-2026-09-03.1',
      CONFIRM: 'release dev to preview',
      DEPLOY_TARGETS: 'ui',
      ENVIRONMENT: 'preview',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_NAME: 'dev',
      ...env,
    },
  });
}

test('release actor guard loads its local action from trusted workflow control', async () => {
  const workflow = await loadReleaseWorkflow();
  const job = workflow.jobs.release_actor_guard;
  const checkouts = checkoutSteps(job);
  const guardIndex = job.steps.findIndex((step) => step?.uses === './.github/actions/release-actor-guard');

  assert.equal(checkouts.length, 1);
  assertTrustedControlCheckout(checkouts[0]);
  assert.ok(job.steps.indexOf(checkouts[0]) < guardIndex, 'trusted checkout must precede the App-credential guard');
});

test('release workflow admits the exact dispatcher-observed workflow-control SHA before downstream work', async () => {
  const workflow = await loadReleaseWorkflow();
  const input = workflow.on.workflow_dispatch.inputs.workflow_control_sha;
  const guard = workflow.jobs.trusted_ref_guard;
  const step = guard.steps.find((candidate) => candidate?.name === 'Verify workflow-control SHA');

  assert.equal(input.required, false);
  assert.equal(input.default, '');
  assert.equal(input.type, 'string');
  assert.equal(step?.env?.WORKFLOW_CONTROL_SHA, '${{ inputs.workflow_control_sha }}');
  assert.equal(step?.env?.WORKFLOW_SHA, '${{ github.sha }}');
  assert.match(step?.run ?? '', /\^\[0-9a-f\]\{40\}\$/);
  assert.match(step?.run ?? '', /\[ "\$WORKFLOW_SHA" != "\$WORKFLOW_CONTROL_SHA" \]/);
  assert.ok(workflow.jobs.release_actor_guard.needs.includes('trusted_ref_guard'));

  const manual = spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, WORKFLOW_CONTROL_SHA: '', WORKFLOW_SHA: WORKFLOW_CONTROL_SHA },
  });
  assert.equal(manual.status, 0, 'the supported direct manual workflow dispatch remains available');

  const accepted = spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, WORKFLOW_CONTROL_SHA, WORKFLOW_SHA: WORKFLOW_CONTROL_SHA },
  });
  assert.equal(accepted.status, 0);

  const drifted = spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, WORKFLOW_CONTROL_SHA, WORKFLOW_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  });
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /workflow-control SHA drift/i);

  for (const mutationJobName of [
    'promote_preview',
    'promote_main',
    'deploy_ui',
    'deploy_server',
    'publish_server_runtime',
    'publish_ui_web',
    'publish_cli_binaries',
    'publish_hstack_binaries',
    'promote_server_runtime',
    'promote_ui_web',
    'promote_cli_binaries',
    'promote_hstack_binaries',
    'publish_docker',
    'deploy_website',
    'deploy_docs',
    'publish_npm',
    'sync_dev',
  ]) {
    assert.equal(
      dependsTransitivelyOn(workflow, mutationJobName, 'trusted_ref_guard'),
      true,
      `${mutationJobName} must remain downstream of workflow-control SHA admission`,
    );
  }
});

test('deploy planning keeps release source inert and executes trusted workflow control', async () => {
  const workflow = await loadReleaseWorkflow();
  const job = workflow.jobs.deploy_plan;

  assert.equal(job.environment, undefined, 'deploy planning must not request release-shared secrets');
  assert.equal(job.permissions?.contents, 'read');
  assert.equal(
    job.steps.some((step) => step?.uses === 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547'),
    false,
    'deploy planning does not need an App token',
  );

  const checkouts = checkoutSteps(job);
  assert.equal(checkouts.length, 2);
  assertTrustedControlCheckout(checkouts[0]);
  assert.equal(checkouts[1]?.with?.repository, '${{ github.repository }}');
  assert.equal(checkouts[1]?.with?.path, 'release-source');
  assert.equal(checkouts[1]?.with?.['persist-credentials'], false);

  const compute = job.steps.find((step) => step?.id === 'plan');
  assert.equal(compute?.['working-directory'], 'release-source');
  assert.match(compute?.run ?? '', /node \.\.\/scripts\/pipeline\/release\/compute-deploy-plan\.mjs/);
  assert.doesNotMatch(compute?.run ?? '', /node scripts\//, 'candidate source must not supply executable planning code');
  assertNoExpressionInterpolationInShell(job, 'deploy_plan');
});

test('final exact-SHA release workflow has no post-admission version-bump mutation job', async () => {
  const workflow = await loadReleaseWorkflow();
  assert.equal(workflow.jobs.bump_versions_dev, undefined);
});

test('public exact-SHA release admission rejects non-none bumps before branch mutation', async () => {
  const workflow = await loadReleaseWorkflow();
  const validation = workflow.jobs.ci.steps.find((step) => step?.name === 'Validate release dispatch');
  assert.match(validation?.run ?? '', /validate-release-dispatch\.mjs/);

  for (const dryRun of ['false', 'true']) {
    for (const bump of ['patch', 'minor', 'major']) {
      const result = runReleaseInputValidation({ BUMP: bump, DRY_RUN: dryRun });
      assert.notEqual(result.status, 0, `bump=${bump} must not create a post-approval promotion commit`);
      assert.match(
        result.stderr,
        /already be materialized; final exact-SHA promotion requires bump=none/,
      );
    }
  }

  assert.equal(
    runReleaseInputValidation({ BUMP: 'none', DRY_RUN: 'false' }).status,
    0,
    'the final exact-SHA promotion path should admit an already materialized candidate',
  );
  assert.equal(validation?.env?.BUMP, '${{ inputs.bump }}');
  const bumpPlan = workflow.jobs.plan.steps.find((step) => step?.id === 'bump_plan');
  assert.equal(
    bumpPlan?.env?.BUMP_PRESET,
    '${{ inputs.bump }}',
    'the resolved bump plan must receive the same final-admission input',
  );
  for (const override of ['BUMP_APP_OVERRIDE', 'BUMP_CLI_OVERRIDE', 'BUMP_STACK_OVERRIDE']) {
    assert.equal(
      bumpPlan?.env?.[override],
      'preset',
      `${override} must not reintroduce a component-specific bump after bump=none admission`,
    );
  }
  assert.equal(workflow.jobs.bump_versions_dev, undefined);
});

test('release dispatch accepts the canonical public SDK release targets', () => {
  const result = runReleaseInputValidation({
    BUMP: 'none',
    DRY_RUN: 'true',
    DEPLOY_TARGETS: 'plugin_sdk,sdk',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('trusted bump orchestrator never executes a candidate-local bump script', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-release-bump-trust-'));
  const candidateRoot = join(tempRoot, 'candidate');
  const remoteRoot = join(tempRoot, 'remote.git');
  const marker = join(tempRoot, 'candidate-script-executed');
  const trustedScript = join(repoRoot, 'scripts', 'pipeline', 'release', 'bump-versions-dev.mjs');

  try {
    await mkdir(candidateRoot, { recursive: true });
    execFileSync('git', ['init', '--bare', remoteRoot]);
    execFileSync('git', ['init'], { cwd: candidateRoot });
    execFileSync('git', ['config', 'user.name', 'Release Trust Test'], { cwd: candidateRoot });
    execFileSync('git', ['config', 'user.email', 'release-trust@example.invalid'], { cwd: candidateRoot });
    execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: candidateRoot });

    for (const rel of [
      'apps/ui/package.json',
      'apps/server/package.json',
      'apps/website/package.json',
      'apps/cli/package.json',
      'apps/stack/package.json',
      'packages/relay-server/package.json',
      'packages/plugin-sdk/package.json',
      'packages/plugin-ui/package.json',
      'packages/sdk/package.json',
    ]) {
      await mkdir(dirname(join(candidateRoot, rel)), { recursive: true });
      await writeFile(join(candidateRoot, rel), '{"version":"1.0.0"}\n');
    }
    await writeFile(join(candidateRoot, 'apps/ui/app.config.js'), 'export default { version: "1.0.0" };\n');
    execFileSync('git', ['add', '.'], { cwd: candidateRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: candidateRoot });

    const candidateScript = join(candidateRoot, 'scripts', 'pipeline', 'release', 'bump-version.mjs');
    await mkdir(dirname(candidateScript), { recursive: true });
    await writeFile(candidateScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);

    execFileSync(process.execPath, [trustedScript, '--bump-cli', 'patch'], {
      cwd: candidateRoot,
      stdio: 'pipe',
    });

    const cliPackage = JSON.parse(await readFile(join(candidateRoot, 'apps/cli/package.json'), 'utf8'));
    assert.equal(cliPackage.version, '1.0.1');
    await assert.rejects(access(marker), 'candidate-local executable must remain inert');
    assert.equal(execFileSync('git', ['rev-parse', 'refs/remotes/origin/dev'], { cwd: candidateRoot, encoding: 'utf8' }).trim().length, 40);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
