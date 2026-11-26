import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readEvidenceScript() {
  const workflow = parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-source-validation.yml'), 'utf8'));
  const step = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).find((candidate) => candidate.id === 'evidence');
  assert.ok(step?.run, 'expected the source-validation evidence step');
  return step.run;
}

async function runEvidence(env) {
  const dir = await mkdtemp(join(tmpdir(), 'source-evidence-'));
  try {
    const output = join(dir, 'output');
    const result = spawnSync('bash', ['-c', await readEvidenceScript()], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        DRY_RUN: 'false',
        SOURCE_PLAN_RESULT: 'success',
        SOURCE_SHA: 'a'.repeat(40),
        SOURCE_CONTRACTS_RESULT: 'success',
        RUN_MYSQL: 'true',
        RUN_PLATFORM: 'true',
        RUN_TRUST_ROOTS: 'true',
        TRUST_ROOTS_RESULT: 'success',
        ...env,
      },
      encoding: 'utf8',
    });
    return result.status;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a CI waiver accepts the source-only MySQL and platform gates it skips', async () => {
  // Release run 45608053282: waive_ci skipped both jobs, then this projection required them.
  assert.equal(await runEvidence({ WAIVE_CI: 'true', CI_RESULT: 'skipped', MYSQL_RESULT: 'skipped', PLATFORM_RESULT: 'skipped' }), 0);
});

test('without a waiver the selected MySQL and platform gates must succeed', async () => {
  const passing = { WAIVE_CI: 'false', CI_RESULT: 'success', MYSQL_RESULT: 'success', PLATFORM_RESULT: 'success' };
  assert.equal(await runEvidence(passing), 0);
  assert.notEqual(await runEvidence({ ...passing, MYSQL_RESULT: 'skipped' }), 0);
  assert.notEqual(await runEvidence({ ...passing, PLATFORM_RESULT: 'failure' }), 0);
});

test('a waiver still requires source contracts and selected trust roots', async () => {
  const waived = { WAIVE_CI: 'true', CI_RESULT: 'skipped', MYSQL_RESULT: 'skipped', PLATFORM_RESULT: 'skipped' };
  assert.notEqual(await runEvidence({ ...waived, SOURCE_CONTRACTS_RESULT: 'failure' }), 0);
  assert.notEqual(await runEvidence({ ...waived, TRUST_ROOTS_RESULT: 'skipped' }), 0);
});
