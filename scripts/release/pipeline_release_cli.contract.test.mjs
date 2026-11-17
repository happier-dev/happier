import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release dry-run reports hosted deploy inputs without predicting deploy jobs', async () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release dev to preview',
        '--deploy-environment',
        'preview',
        '--deploy-targets',
        'server',
        '--force-deploy',
        'true',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-release',
        '--waive-ci',
        'true',
        '--include-validation-suites',
        'installers-smoke',
        '--waive-validation-suites',
        'docker-release-assets',
        '--override-reason',
        'Maintainer accepted the bounded release risk.',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...stub.env,
          DEPLOY_WEBHOOK_URL: 'https://ci.example.com/api/deploy',
          CF_WEBHOOK_DEPLOY_CLIENT_ID: 'cf-id',
          CF_WEBHOOK_DEPLOY_CLIENT_SECRET: 'cf-secret',
          HAPPIER_SERVER_API_DEPLOY_WEBHOOKS: 'server-api',
          HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS: 'server-worker',
          GH_TOKEN: '',
          GH_REPO: '',
          GITHUB_REPOSITORY: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.match(out, /\[pipeline\] release: environment=preview confirm=release dev to preview/);
    assert.match(out, /release profile=integrated/);
    assert.doesNotMatch(out, /hosted checks profile|checks_profile/, 'the hosted workflow resolves checks from the public profile');
    assert.match(out, /\[pipeline\] dry-run: hosted dispatch inputs/);
    assert.match(out, /- deploy_targets: server/);
    assert.match(out, /- force_deploy: true/);
    assert.match(out, /- waive_ci: true/);
    assert.match(out, /- include_validation_suites: installers-smoke/);
    assert.match(out, /- waive_validation_suites: docker-release-assets/);
    assert.match(out, /- override_reason: Maintainer accepted the bounded release risk\./);
    assert.doesNotMatch(out, /runDeployServer|runPublish/);
  } finally {
    stub.cleanup();
  }
});

test('release planning rejects unknown suites from flags and approved packet inputs before emitting transport', () => {
  const stub = createReleaseCliDryRunEnv();
  const root = mkdtempSync(resolve(tmpdir(), 'release-suite-admission-'));
  const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');
  const args = [pipelineCli, 'release', '--confirm', 'release dev to preview',
    '--repository', 'happier-dev/happier', '--deploy-environment', 'preview',
    '--release-notes-id', 'test-release', '--operation-id', 'rel_suite_validation',
    '--attempt-id', 'attempt_1', '--ci-run-id', '123', '--dry-run', '--json'];
  const run = (extra) => spawnSync(process.execPath, [...args, ...extra], {
    cwd: repoRoot, env: stub.env, encoding: 'utf8', timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
  });
  try {
    const valid = run([]);
    assert.equal(valid.status, 0, valid.stderr);
    const plan = JSON.parse(valid.stdout);
    for (const [flag, input, override] of [
      ['--include-validation-suites', 'include_validation_suites', 'includeValidationSuiteIds'],
      ['--waive-validation-suites', 'waive_validation_suites', 'waiveValidationSuiteIds'],
    ]) {
      const approved = structuredClone(plan);
      approved.hostedDispatch.inputs[input] = 'mysql-contract';
      approved.hostedDispatch.inputs.override_reason = 'Approved validation refinement';
      approved.overrides[override] = ['mysql-contract'];
      approved.overrides.reason = 'Approved validation refinement';
      const approvedPath = resolve(root, 'approved-intent.json');
      writeFileSync(approvedPath, JSON.stringify(approved));
      for (const [source, extra] of [
        ['flag', [flag, 'mysql-contract', '--override-reason', 'Approved validation refinement']],
        ['approved packet', ['--approved-intent', approvedPath]],
      ]) {
        const result = run(extra);
        assert.equal(result.status, 1, `${source} ${flag}: ${result.stderr}`);
        assert.match(result.stderr, /Unknown release validation suite.*mysql-contract/);
        assert.equal(result.stdout, '', 'refused suites must not emit dispatch transport');
      }
    }
  } finally {
    stub.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline CLI release dry-run defaults production to the stable release profile', async () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release preview to main',
        '--deploy-environment',
        'production',
        '--deploy-targets',
        'server',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-release',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...stub.env,
          DEPLOY_WEBHOOK_URL: 'https://ci.example.com/api/deploy',
          CF_WEBHOOK_DEPLOY_CLIENT_ID: 'cf-id',
          CF_WEBHOOK_DEPLOY_CLIENT_SECRET: 'cf-secret',
          HAPPIER_SERVER_API_DEPLOY_WEBHOOKS: 'server-api',
          HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS: 'server-worker',
          GH_TOKEN: '',
          GH_REPO: '',
          GITHUB_REPOSITORY: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.match(out, /\[pipeline\] release: environment=production confirm=release preview to main/);
    assert.match(out, /release profile=stable/);
    assert.doesNotMatch(out, /hosted checks profile|checks_profile/, 'the local dispatcher must not become a second checks-profile owner');
  } finally {
    stub.cleanup();
  }
});

test('pipeline CLI rejects the manual deep profile before release work begins', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release',
      '--confirm',
      'release dev to preview',
      '--deploy-environment',
      'preview',
      '--deploy-targets',
      'server',
      '--repository',
      'happier-dev/happier',
      '--release-notes-id',
      'test-release',
      '--release-profile',
      'deep',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /manual comprehensive certification/i);
});

test('pipeline CLI does not expose a release-time version bump option', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release dev to preview',
        '--deploy-environment',
        'preview',
        '--deploy-targets',
        'server',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-release',
        '--bump',
        'patch',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option '--bump'/);
  } finally {
    stub.cleanup();
  }
});
