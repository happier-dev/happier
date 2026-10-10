import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

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
        '--qualified-v4-activation-approval',
        'false',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.deepEqual(JSON.parse(raw), {
      kind: 'happier.release-dispatch-plan.v3',
      schemaVersion: 3,
      sourceBranch: 'preview',
      productionPromotionMode: 'fast-forward',
      authorizedPromotionSourceSha: '3333333333333333333333333333333333333333',
      effectiveDeployTargets: ['ui', 'server', 'website', 'docs'],
      uiExpoAction: 'none',
      desktopMode: 'none',
      validationProfile: 'stable',
      operationId: 'rel_candidate_20260809',
      releaseNotesId: '2026-08-09.1',
      approvals: { qualifiedV4Activation: false },
      overrides: {
        waiveCi: false,
        includeValidationSuiteIds: [],
        waiveValidationSuiteIds: [],
        reason: '',
      },
    });
  } finally {
    stub.cleanup();
  }
});

test('release dry-run JSON records an explicit production reset without changing the authorized preview source', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const raw = execFileSync(
      process.execPath,
      [
        pipelineCli,
        'release',
        '--confirm',
        'reset main from preview',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'production',
        '--dry-run',
        '--json',
        '--operation-id',
        'rel_reset_20260902',
        '--release-notes-id',
        '2026-08-29.1',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );
    assert.deepEqual(JSON.parse(raw), {
      kind: 'happier.release-dispatch-plan.v3',
      schemaVersion: 3,
      sourceBranch: 'preview',
      productionPromotionMode: 'reset',
      authorizedPromotionSourceSha: '3333333333333333333333333333333333333333',
      effectiveDeployTargets: ['ui', 'server', 'website', 'docs'],
      uiExpoAction: 'none',
      desktopMode: 'none',
      validationProfile: 'stable',
      operationId: 'rel_reset_20260902',
      releaseNotesId: '2026-08-29.1',
      approvals: { qualifiedV4Activation: false },
      overrides: {
        waiveCi: false,
        includeValidationSuiteIds: [],
        waiveValidationSuiteIds: [],
        reason: '',
      },
    });
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

test('combined preview and production dry-run binds one exact dev source and stable validation profile', () => {
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
    assert.equal(plan.kind, 'happier.release-dispatch-plan.v3');
    assert.equal(plan.sourceBranch, 'dev');
    assert.equal(plan.productionPromotionMode, 'fast-forward');
    assert.equal(plan.authorizedPromotionSourceSha, '2222222222222222222222222222222222222222');
    assert.equal(plan.validationProfile, 'stable');
    assert.equal(plan.operationId, 'rel_combined_20260907');
  } finally {
    stub.cleanup();
  }
});

test('new combined release plans stay at an explicitly selected candidate after dev advances', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-release-pinned-target-'));
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, ['init', 'work']);
  const work = resolve(root, 'work');
  git(work, ['config', 'user.name', 'Release Test']);
  git(work, ['config', 'user.email', 'release-test@example.invalid']);
  git(work, ['commit', '--allow-empty', '-m', 'validated candidate']);
  const candidate = git(work, ['rev-parse', 'HEAD']);
  git(work, ['commit', '--allow-empty', '-m', 'later merge']);
  const tip = git(work, ['rev-parse', 'HEAD']);
  git(root, ['init', '--bare', 'remote.git']);
  git(work, ['remote', 'add', 'origin', resolve(root, 'remote.git')]);
  git(work, ['push', 'origin', 'HEAD:refs/heads/dev']);
  const plan = (sourceArgs) => JSON.parse(execFileSync(process.execPath, [
    pipelineCli, 'release', '--confirm', 'release dev to preview and main',
    '--repository', 'happier-dev/happier',
    '--deploy-environment', 'preview-and-production', '--dry-run', '--json',
    '--operation-id', 'rel_pinned_candidate', '--release-notes-id', '2026-10-08.1', ...sourceArgs,
  ], { cwd: work, env: { ...process.env, HAPPIER_PIPELINE_REPO_ROOT: work }, encoding: 'utf8' }));
  assert.equal(plan(['--source-sha', candidate]).authorizedPromotionSourceSha, candidate);
  assert.equal(plan([]).authorizedPromotionSourceSha, tip);
  git(work, ['commit', '--allow-empty', '-m', 'another merge']);
  git(work, ['push', 'origin', 'HEAD:refs/heads/dev']);
  assert.equal(plan(['--source-sha', candidate]).authorizedPromotionSourceSha, candidate);
});

test('both release snapshot paths bind issue eligibility to the cumulative candidate before promotion', async () => {
  const single = parse(await readFile(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8'));
  const combined = parse(await readFile(resolve(repoRoot, '.github/workflows/release-preview-and-production.yml'), 'utf8'));
  const snapshot = single.jobs.snapshot_release_issues;
  assert.ok(snapshot.needs.includes('release_preflight'));
  const step = snapshot.steps.find((item) => item.id === 'snapshot');
  assert.equal(step.env.CANDIDATE_SHA, '${{ needs.release_preflight.outputs.source_sha }}');
  assert.equal(step.env.BASE_SHA, undefined);
  for (const job of [snapshot, combined.jobs.snapshot_release_issues]) {
    const run = job.steps.find((item) => item.id === 'snapshot').run;
    for (const line of run.split('\n').filter((item) => item.includes('reconcile-issue-stage.mjs snapshot'))) {
      assert.doesNotMatch(line, /--base-sha/);
      assert.match(line, /--candidate-sha "\$CANDIDATE_SHA"/);
    }
  }
});

test('only development synchronization may retain a target already containing the release candidate', async () => {
  const release = parse(await readFile(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8'));
  const promote = parse(await readFile(resolve(repoRoot, '.github/workflows/promote-branch.yml'), 'utf8'));
  assert.equal(release.jobs.sync_dev.with.preserve_target_descendant, true);
  for (const job of [release.jobs.promote_main, release.jobs.promote_preview]) {
    assert.notEqual(job.with.preserve_target_descendant, true);
  }
  assert.equal(promote.on.workflow_call.inputs.preserve_target_descendant.default, false);
  const step = promote.jobs.promote.steps.find((item) => item.name === 'Promote branch (pipeline)');
  assert.equal(step.env.INPUT_PRESERVE_TARGET_DESCENDANT, '${{ inputs.preserve_target_descendant == true }}');
  assert.match(step.run, /--preserve-target-descendant/);
});

test('release workflow admits one authorized promotion-source SHA and passes it to both branch promotion paths', async () => {
  const raw = await readFile(resolve(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(raw, /authorized_promotion_source_sha:\s*\n\s*description: "Safety — exact source branch SHA approved for promotion"/);
  assert.match(raw, /hmaint_operation_id:\s*\n\s*description: "Safety — conductor operation ID; leave empty only for emergency direct manual dispatch"/);
  assert.match(raw, /release_notes_id:\s*\n\s*description: "Release notes — Exact approved project release ID"/);
  assert.match(raw, /AUTHORIZED_PROMOTION_SOURCE_SHA:\s*\$\{\{ inputs\.authorized_promotion_source_sha \}\}/);
  assert.match(raw, /HMAINT_OPERATION_ID:\s*\$\{\{ inputs\.hmaint_operation_id \}\}/);
  assert.match(raw, /RELEASE_NOTES_ID:\s*\$\{\{ inputs\.release_notes_id \}\}/);
  assert.match(raw, /scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  assert.match(raw, /run-name:\s*\$\{\{ inputs\.hmaint_operation_id != '' && format\('RELEASE — Publish \(\{0\}, \{1\}\)', inputs\.hmaint_operation_id, inputs\.hmaint_attempt_id\) \|\| 'RELEASE — Publish \(manual\)' \}\}/);
  assert.match(
    raw,
    /Checkout authorized release planning source[\s\S]*?ref: \$\{\{ needs\.release_preflight\.outputs\.source_sha \}\}/,
  );
  assert.match(raw, /promote_main:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /promote_preview:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /sync_dev:[\s\S]*?source_sha: \$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/);
});
