import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_RELEASE_CI_LANES, validateCiLaneSummary, validateCanonicalCiRun } from './verify-existing-ci.mjs';

const sha = 'a'.repeat(40);
const expected = {
  repository: 'happier-dev/happier',
  workflow: 'tests.yml',
  sourceSha: sha,
  sourceBranch: 'dev',
  runId: '42',
};

test('default release admission trusts the canonical CI selector instead of requiring intentionally unselected lanes', () => {
  assert.deepEqual(DEFAULT_RELEASE_CI_LANES, ['ci_plan', 'trusted_ref_guard']);
});

test('admits only the explicitly named successful canonical push CI run', () => {
  assert.doesNotThrow(() => validateCanonicalCiRun({
    id: 42,
    path: '.github/workflows/tests.yml',
    head_sha: sha,
    head_branch: 'dev',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: 'happier-dev/happier' },
  }, expected));

  for (const run of [
    { id: 43, path: '.github/workflows/tests.yml', head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 42, path: '.github/workflows/other.yml', head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } },
    { id: 42, path: '.github/workflows/tests.yml', head_sha: sha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'failure', head_repository: { full_name: 'happier-dev/happier' } },
  ]) {
    assert.throws(() => validateCanonicalCiRun(run, expected), /not a successful canonical push CI/);
  }
});

test('validates the CI lane attestation and required release lanes', () => {
  const summary = {
    schemaVersion: 1,
    runId: '42',
    sourceSha: sha,
    workflow: 'CI — Tests',
    lanes: [
      { id: 'typecheck', result: 'success', conclusion: null, outputs: {} },
      { id: 'server', result: 'success', conclusion: null, outputs: {} },
      { id: 'stress', result: 'skipped', conclusion: null, outputs: {} },
    ],
    failures: [],
  };
  assert.deepEqual(
    validateCiLaneSummary(summary, { runId: '42', sourceSha: sha, requiredLanes: ['typecheck', 'server'] }),
    summary,
  );
});

test('rejects CI evidence whose classifier-selected lane is not successful', () => {
  const classifierOutputs = Object.fromEntries([
    'run_ui', 'run_server', 'run_cli', 'run_stack', 'run_ui_e2e', 'run_server_db_contract',
    'run_release_contracts', 'run_installers_smoke', 'run_binary_smoke', 'run_cli_daemon_e2e',
    'run_e2e_core', 'run_typecheck',
  ].map((key) => [key, key === 'run_server' ? 'true' : 'false']));
  const summary = {
    schemaVersion: 1,
    runId: '42',
    sourceSha: sha,
    workflow: 'CI — Tests',
    lanes: [
      { id: 'ci_plan', result: 'success', conclusion: null, outputs: classifierOutputs },
      { id: 'trusted_ref_guard', result: 'success', conclusion: null, outputs: {} },
      { id: 'server', result: 'skipped', conclusion: null, outputs: {} },
    ],
    failures: [],
  };
  assert.throws(
    () => validateCiLaneSummary(summary, { runId: '42', sourceSha: sha, requiredLanes: [...DEFAULT_RELEASE_CI_LANES] }),
    /classifier-selected lane server did not succeed/,
  );
});

test('rejects mismatched, failed, malformed, or skipped required CI evidence', () => {
  const base = {
    schemaVersion: 1,
    runId: '42',
    sourceSha: sha,
    workflow: 'CI — Tests',
    lanes: [{ id: 'typecheck', result: 'success', conclusion: null, outputs: {} }],
    failures: [],
  };
  for (const [summary, pattern] of [
    [{ ...base, schemaVersion: 2 }, /schema version/],
    [{ ...base, runId: '41' }, /run ID/],
    [{ ...base, sourceSha: 'b'.repeat(40) }, /source SHA/],
    [{ ...base, failures: [{ id: 'server', result: 'failure' }] }, /reports failed lanes/],
    [{ ...base, lanes: [{ id: 'typecheck', result: 'skipped' }] }, /required lane typecheck/],
    [{ ...base, lanes: [] }, /required lane typecheck/],
  ]) {
    assert.throws(() => validateCiLaneSummary(summary, { runId: '42', sourceSha: sha, requiredLanes: ['typecheck'] }), pattern);
  }
});

test('requires an explicit run ID and the machine-readable summary artifact', () => {
  const source = readFileSync(new URL('./verify-existing-ci.mjs', import.meta.url), 'utf8');
  assert.match(source, /--run-id is required/);
  assert.match(source, /ci-lane-summary/);
  assert.doesNotMatch(source, /actions\/workflows\/.+\/runs\?/s, 'admission must not scan workflow runs');
});
