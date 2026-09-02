import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');
const reviewedSetupNodeUse = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';

test('workflows use Node 22 policy and do not pin Node 20', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.doesNotMatch(raw, /node-version:\s*20\b/, `${file} must not use node-version: 20`);
    assert.doesNotMatch(raw, /NODE_VERSION:\s*"20"/, `${file} must not use NODE_VERSION=20`);
    assert.doesNotMatch(raw, /node-version:\s*\[[^\]]*\b20\b[^\]]*\]/, `${file} must not include Node 20 in a matrix`);
  }
});

test('workflows that run pipeline scripts set up Node 22', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    if (!raw.includes('node scripts/pipeline/')) continue;
    assert.ok(
      raw.includes(reviewedSetupNodeUse),
      `${file} must include the reviewed actions/setup-node v4 action when running pipeline scripts`,
    );
    const hasDirect22 = /node-version:\s*22(\.x)?\b/.test(raw);
    const usesEnvNodeVersion = /node-version:\s*\$\{\{\s*env\.NODE_VERSION\s*\}\}/.test(raw) && /NODE_VERSION:\s*"?22\.x"?/.test(raw);
    assert.ok(hasDirect22 || usesEnvNodeVersion, `${file} must use node-version 22.x when running pipeline scripts`);
  }
});

function assertCanonicalCorepackBeforeYarn(job, label) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const [index, step] of steps.entries()) {
    const run = String(step?.run ?? '');
    const installsDependencies = step?.uses === './.github/actions/install-yarn-dependencies';
    const runsYarn = /(^|\s)(?:corepack\s+)?yarn(?:\s|$)/m.test(run);
    if (!installsDependencies && !runsYarn) continue;

    assert.ok(
      steps.slice(0, index).some((candidate) => candidate?.uses === './.github/actions/enable-corepack-yarn'),
      `${label} must use the canonical retrying Corepack owner before '${step?.name ?? '<unnamed>'}'`,
    );
  }
}

test('release and extended validation workflows use canonical Corepack and dependency-install owners', async () => {
  const files = [
    'build-tauri.yml',
    'build-ui-mobile-local.yml',
    'extended-db-tests.yml',
    'promote-docs.yml',
    'release-npm.yml',
    'promote-ui.yml',
    'promote-server.yml',
    'promote-website.yml',
    'publish-cli-binaries.yml',
    'publish-docker.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
    'publish-ui-mobile-dev.yml',
    'publish-ui-web.yml',
  ];

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    const workflow = YAML.parse(raw);
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      assertCanonicalCorepackBeforeYarn(job, `${file}/${jobName}`);
    }
    assert.doesNotMatch(raw, /corepack prepare yarn@1\.22\.22 --activate/, `${file} should not bypass the retry owner`);
    assert.doesNotMatch(raw, /(^|\s)corepack enable(?:\s|$)/m, `${file} should not inline Corepack setup`);
    assert.doesNotMatch(raw, /bash scripts\/ci\/yarn-install-with-retry\.sh/, `${file} should not bypass the dependency-install action`);
  }
});

test('every workflow runner job declares a positive timeout bound', async () => {
  const files = (await readdir(workflowsDir))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const unboundedJobs = [];

  for (const file of files) {
    const workflow = YAML.parse(await readFile(join(workflowsDir, file), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (!job?.['runs-on']) continue;
      if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] <= 0) {
        unboundedJobs.push(`${file}/${jobName}`);
      }
    }
  }
  assert.deepEqual(
    unboundedJobs,
    [],
    `runner jobs missing a positive timeout-minutes bound:\n${unboundedJobs.join('\n')}`,
  );

  const minimumTimeouts = {
    'cli-smoke-test.yml': {
      'smoke-test-linux': 60,
      'smoke-test-windows': 60,
    },
    'issue-needs-handoff.yml': { reconcile: 10 },
    'issue-triage-manual.yml': { 'triage-manual': 30 },
    'issue-triage.yml': { triage: 30 },
    'roadmap-add-to-project.yml': { 'add-to-project': 15 },
    'roadmap-bootstrap-labels.yml': { bootstrap: 15 },
    'deploy.yml': {
      trusted_ref_guard: 10,
      release_actor_guard: 15,
      deploy: 30,
    },
    'deploy-on-deploy-branch.yml': {
      trusted_ref_guard: 10,
      release_actor_guard: 15,
      target: 10,
    },
    'providers-contracts.yml': {
      release_actor_guard: 15,
      trusted_ref_guard: 10,
    },
    'publish-ui-mobile-dev.yml': {
      trusted_ref_guard: 10,
      release_actor_guard: 45,
      prepare_ota: 90,
      publish_ota: 90,
      publish: 180,
      ios_cloud: 180,
      ios_local: 180,
    },
    'release-verify.yml': {
      verify_candidate: 120,
      resolve_validation_profile: 15,
    },
    'build-tauri.yml': { build: 180, finalize: 240 },
    'build-ui-mobile-local.yml': { build_android: 180, build_ios: 180, ota_update: 90 },
    'promote-docs.yml': { deploy_cloudflare: 60 },
    'promote-website.yml': { deploy_cloudflare: 60 },
    'publish-docker.yml': { publish: 120 },
    'release-npm.yml': { release: 120 },
    'tests-dispatch.yml': {
      resolve: 10,
      release_actor_guard: 15,
      trusted_ref_guard: 10,
    },
  };

  for (const [file, expectedJobs] of Object.entries(minimumTimeouts)) {
    const workflow = YAML.parse(await readFile(join(workflowsDir, file), 'utf8'));
    for (const [jobName, minimum] of Object.entries(expectedJobs)) {
      assert.ok(
        workflow.jobs?.[jobName]?.['timeout-minutes'] >= minimum,
        `${file}/${jobName} must allow at least ${minimum} minutes for its owning operation`,
      );
    }
  }
});

test('metadata-only and opaque binary-promotion jobs do not install workspace dependencies', async () => {
  const jobsByWorkflow = {
    'publish-cli-binaries.yml': ['prepare', 'promote_existing'],
    'publish-docker.yml': ['publish'],
    'publish-hstack-binaries.yml': ['prepare', 'promote_existing'],
    'publish-ui-web.yml': ['promote_existing'],
  };

  for (const [file, jobNames] of Object.entries(jobsByWorkflow)) {
    const workflow = YAML.parse(await readFile(join(workflowsDir, file), 'utf8'));
    for (const jobName of jobNames) {
      const job = workflow.jobs?.[jobName];
      assert.ok(job, `${file} should define ${jobName}`);
      const serialized = JSON.stringify(job);
      assert.doesNotMatch(serialized, /enable-corepack-yarn/, `${file}/${jobName} does not execute Yarn`);
      assert.doesNotMatch(serialized, /install-yarn-dependencies/, `${file}/${jobName} must consume prepared or opaque bytes`);
      assert.doesNotMatch(serialized, /setup-bun/, `${file}/${jobName} does not execute Bun`);
      for (const step of job.steps ?? []) {
        if (step?.uses !== reviewedSetupNodeUse) continue;
        assert.equal(step.with?.cache, undefined, `${file}/${jobName} must not initialize a package-manager cache`);
        assert.equal(step.with?.['cache-dependency-path'], undefined, `${file}/${jobName} must not initialize a package-manager cache`);
      }
    }
  }
});

test('nightly release workflows use the retrying Corepack Yarn owner', async () => {
  const actionUse = 'uses: ./.github/actions/enable-corepack-yarn';
  const files = [
    'publish-cli-binaries.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
    'publish-ui-web.yml',
    'publish-ui-mobile-dev.yml',
    'build-tauri.yml',
    'tests.yml',
  ];

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.ok(raw.includes(actionUse), `${file} should use the retrying Corepack Yarn action`);
    assert.doesNotMatch(raw, /corepack prepare yarn@1\.22\.22 --activate/, `${file} should not bypass the retry owner`);
  }

  const action = await readFile(join(repoRoot, '.github', 'actions', 'enable-corepack-yarn', 'action.yml'), 'utf8');
  assert.match(action, /bash scripts\/ci\/corepack-prepare-yarn-with-retry\.sh/);
});
