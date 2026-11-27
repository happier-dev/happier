import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

for (const [environment, confirm, sourceSha] of [
  ['preview', 'release dev to preview', '2'.repeat(40)],
  ['production', 'release preview to main', '3'.repeat(40)],
  ['preview-and-production', 'release dev to preview and main', '2'.repeat(40)],
]) {
  test(`hosted ${environment} release forwards exact authority to the canonical workflow`, () => {
    const stub = createReleaseCliDryRunEnv(process.env, { captureWorkflowDispatch: true });
    try {
      execFileSync(process.execPath, [
        pipelineCli, 'release', '--confirm', confirm,
        '--repository', 'happier-dev/happier', '--deploy-environment', environment,
        '--source-sha', sourceSha, '--operation-id', 'rel_dispatch_20261002',
        '--release-notes-id', '2026-10-02.1', '--ui-expo-action', 'full',
        '--plugin-sdk-ready', 'true', '--plugin-sdk-api-classification', 'compatible',
      ], {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      });
      const args = JSON.parse(readFileSync(stub.workflowDispatchArgsPath, 'utf8'));
      assert.deepEqual(args.slice(0, 3), ['workflow', 'run', 'release.yml']);
      const fields = Object.fromEntries(args.flatMap((value, index) => {
        if (value !== '-f') return [];
        const field = args[index + 1];
        const equals = field.indexOf('=');
        return [[field.slice(0, equals), field.slice(equals + 1)]];
      }));
      assert.equal(fields.environment, environment);
      assert.equal(fields.confirm, confirm);
      assert.equal(fields.authorized_promotion_source_sha, sourceSha);
      assert.equal(fields.ui_expo_action, 'full');
      assert.deepEqual(JSON.parse(fields.public_sdk_release_approval).pluginSdk, {
        ready: true, apiClassification: 'compatible', migrationNotes: 'not_required',
      });
      assert.equal(fields.plugin_sdk_ready, undefined);
    } finally {
      stub.cleanup();
    }
  });
}

test('release dry-run JSON resolves the actual promotion source independently of workflow-control HEAD', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const raw = execFileSync(
      process.execPath,
      [
        pipelineCli,
        'release',
        '--confirm',
        'release preview to main',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'production',
        '--dry-run',
        '--json',
        '--operation-id',
        'rel_candidate_20260809',
        '--release-notes-id',
        '2026-08-09.1',
        '--resume-run-id',
        '31506884258',
        '--qualified-v4-activation-approval',
        'true',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    const plan = JSON.parse(raw);
    // Source authorization must survive additive, independently owned release controls.
    for (const [key, expected] of Object.entries({
      kind: 'happier.release-dispatch-plan.v3',
      schemaVersion: 3,
      sourceBranch: 'preview',
      productionPromotionMode: 'fast-forward',
      authorizedPromotionSourceSha: '3333333333333333333333333333333333333333',
      effectiveDeployTargets: ['ui', 'server', 'website', 'docs'],
      uiExpoAction: 'none',
      desktopMode: 'none',
      validationProfile: 'stable',
      overrides: {
        waiveCi: false,
        approvePublicSdkRelease: false,
        includeValidationSuiteIds: [],
        waiveValidationSuiteIds: [],
        reason: '',
      },
      publicSdkApproval: {
        pluginSdkReady: false,
        pluginSdkApiClassification: '',
        pluginSdkMigrationNotes: 'not_required',
        sdkAuthReadiness: 'not_ready',
        sdkAuthWaiver: '',
        sdkApiClassification: '',
        sdkMigrationNotes: 'not_required',
      },
      operationId: 'rel_candidate_20260809',
      releaseNotesId: '2026-08-09.1',
      resumeRunId: '31506884258',
      approvals: { qualifiedV4Activation: true },
    })) {
      assert.deepEqual(plan[key], expected, key);
    }
  } finally {
    stub.cleanup();
  }
});

test('combined preview and production dry-run binds one exact v0.3 source and stable validation profile', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const raw = execFileSync(
      process.execPath,
      [
        pipelineCli,
        'release',
        '--confirm',
        'release dev to preview and main',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'preview-and-production',
        '--dry-run',
        '--json',
        '--operation-id',
        'rel_combined_20260907',
        '--release-notes-id',
        '2026-09-07.1',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );
    const plan = JSON.parse(raw);
    assert.equal(plan.sourceBranch, 'v0.3');
    assert.equal(plan.productionPromotionMode, 'fast-forward');
    assert.equal(plan.authorizedPromotionSourceSha, '2222222222222222222222222222222222222222');
    assert.equal(plan.validationProfile, 'stable');
  } finally {
    stub.cleanup();
  }
});

test('release dry-run JSON requires a canonical conductor operation ID before resolving a source', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const result = spawnSync(
      process.execPath,
      [
        pipelineCli,
        'release',
        '--confirm',
        'release preview to main',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'production',
        '--dry-run',
        '--json',
        '--release-notes-id',
        '2026-08-09.1',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--operation-id is required with --dry-run --json/);
  } finally {
    stub.cleanup();
  }
});

test('release dry-run JSON requires a project release-notes ID before resolving a source', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const result = spawnSync(
      process.execPath,
      [
        pipelineCli,
        'release',
        '--confirm',
        'release preview to main',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'production',
        '--dry-run',
        '--json',
        '--operation-id',
        'rel_candidate_20260809',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--release-notes-id is required/);
  } finally {
    stub.cleanup();
  }
});

test('release workflow admits one authorized promotion-source SHA and passes it to both branch promotion paths', async () => {
  const rootRaw = await readFile(resolve(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const raw = await readFile(resolve(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');

  const inputs = YAML.parse(rootRaw).on.workflow_dispatch.inputs;
  assert.equal(inputs.authorized_promotion_source_sha.type, 'string');
  assert.equal(inputs.hmaint_operation_id.type, 'string');
  assert.equal(inputs.release_notes_id.type, 'string');
  assert.equal(inputs.release_notes_id.required, true);
  assert.match(raw, /AUTHORIZED_PROMOTION_SOURCE_SHA:\s*\$\{\{ inputs\.authorized_promotion_source_sha \}\}/);
  assert.match(raw, /HMAINT_OPERATION_ID:\s*\$\{\{ inputs\.hmaint_operation_id \}\}/);
  assert.match(raw, /RELEASE_NOTES_ID:\s*\$\{\{ inputs\.release_notes_id \}\}/);
  assert.match(raw, /scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  assert.match(rootRaw, /run-name:\s*\$\{\{ inputs\.hmaint_operation_id != '' && format\('RELEASE — Publish \(\{0\}, \{1\}\)', inputs\.hmaint_operation_id, inputs\.hmaint_attempt_id\) \|\| 'RELEASE — Publish \(manual\)' \}\}/);
  assert.match(
    raw,
    /Checkout authorized release planning source[\s\S]*?ref: \$\{\{ inputs\.authorized_promotion_source_sha \|\| needs\.release_preflight\.outputs\.source_ref \}\}/,
  );
  assert.match(raw, /promote_main:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /promote_preview:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /sync_dev:[\s\S]*?source_sha: \$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/);
});


test('channel promotion consumes the admitted source branch and syncs the named development line', () => {
  const channel = YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/release-channel.yml'), 'utf8'));
  for (const jobName of ['promote_main', 'promote_preview']) {
    const job = channel.jobs[jobName];
    assert.ok(job.needs.includes('release_preflight'), `${jobName} must consume preflight's source decision`);
    assert.equal(job.with.source, '${{ needs.release_preflight.outputs.source_ref }}');
    assert.match(job.with.confirm, /needs\.release_preflight\.outputs\.source_ref/);
  }
  assert.equal(channel.jobs.sync_dev.with.target, 'v0.3');
  assert.equal(channel.jobs.sync_dev.with.confirm, 'promote v0.3 from main');
});

test('a selected release candidate stays pinned after its source branch advances', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-release-pinned-candidate-'));
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, ['init', '-q', 'work']);
  const work = resolve(root, 'work');
  git(work, ['config', 'user.name', 'Release Test']);
  git(work, ['config', 'user.email', 'release-test@example.invalid']);
  git(work, ['commit', '-q', '--allow-empty', '-m', 'validated candidate']);
  const candidate = git(work, ['rev-parse', 'HEAD']);
  git(work, ['commit', '-q', '--allow-empty', '-m', 'later merge']);
  git(root, ['init', '-q', '--bare', 'remote.git']);
  git(work, ['remote', 'add', 'origin', resolve(root, 'remote.git')]);
  git(work, ['push', '-q', 'origin', 'HEAD:refs/heads/v0.3']);
  const plan = () => JSON.parse(execFileSync(process.execPath, [
    pipelineCli, 'release', '--confirm', 'release dev to preview and main',
    '--repository', 'happier-dev/happier', '--deploy-environment', 'preview-and-production', '--dry-run', '--json',
    '--operation-id', 'rel_pinned_candidate', '--release-notes-id', '2026-10-08.1', '--source-sha', candidate,
  ], { cwd: work, env: { ...process.env, HAPPIER_PIPELINE_REPO_ROOT: work }, encoding: 'utf8', timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS }));
  assert.equal(plan().authorizedPromotionSourceSha, candidate);
});

test('the channel preflight admits a pinned candidate once and later jobs consume that decision', () => {
  const channel = YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/release-channel.yml'), 'utf8'));
  const bind = channel.jobs.release_preflight.steps.find((step) => step.id === 'source');
  assert.match(bind.run, /resolve-authorized-release-source\.mjs/);
  assert.match(bind.run, /--allow-source-ancestor/);
  assert.match(bind.run, /--authorized-sha "\$AUTHORIZED_PROMOTION_SOURCE_SHA"/);
  const planningSource = channel.jobs.plan.steps.find((step) => step.id === 'planning_source');
  assert.match(planningSource.run, /AUTHORIZED_PROMOTION_SOURCE_SHA/, 'planning still checks out exactly the candidate');
  assert.doesNotMatch(planningSource.run, /ls-remote/, 'planning must not re-decide the source branch tip');
});

test('only development synchronization may retain a target already containing the release candidate', () => {
  const channel = YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/release-channel.yml'), 'utf8'));
  const promote = YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/promote-branch.yml'), 'utf8'));
  assert.equal(channel.jobs.sync_dev.with.preserve_target_descendant, true);
  for (const job of [channel.jobs.promote_main, channel.jobs.promote_preview]) {
    assert.notEqual(job.with.preserve_target_descendant, true);
  }
  assert.equal(promote.on.workflow_call.inputs.preserve_target_descendant.default, false);
  const step = Object.values(promote.jobs).flatMap((job) => job.steps ?? []).find((item) => item.name === 'Promote branch (pipeline)');
  assert.equal(step.env.INPUT_PRESERVE_TARGET_DESCENDANT, '${{ inputs.preserve_target_descendant == true }}');
  assert.match(step.run, /--preserve-target-descendant/);
});
