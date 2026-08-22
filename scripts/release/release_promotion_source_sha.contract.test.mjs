import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

    assert.deepEqual(JSON.parse(raw), {
      kind: 'happier.release-dispatch-plan.v3',
      schemaVersion: 3,
      sourceBranch: 'preview',
      authorizedPromotionSourceSha: '3333333333333333333333333333333333333333',
      effectiveDeployTargets: ['ui', 'server', 'website', 'docs'],
      validationProfile: 'stable',
      operationId: 'rel_candidate_20260809',
      releaseNotesId: '2026-08-09.1',
      resumeRunId: '31506884258',
      approvals: { qualifiedV4Activation: true },
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
    /Checkout authorized release planning source[\s\S]*?ref: \$\{\{ inputs\.authorized_promotion_source_sha \|\| needs\.ci\.outputs\.source_ref \}\}/,
  );
  assert.match(raw, /promote_main:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /promote_preview:[\s\S]*?source_sha: \$\{\{[^\n]+\}\}/);
  assert.match(raw, /sync_dev:[\s\S]*?source_sha: \$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/);
});
