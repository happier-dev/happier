import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceSuiteReuse } from './source-suite-evidence.mjs';
const expected = { runId: '123', sourceSha: 'a'.repeat(40), profile: 'integrated', policy: 'preview', suite: 'release-contracts' };
const summary = () => ({ schemaVersion: 1, runId: '123', sourceSha: expected.sourceSha, failures: [], lanes: [{ id: 'release-contracts', result: 'success', outputs: { source_suite: 'release-contracts', source_profile: 'integrated', source_policy: 'preview', source_sha: expected.sourceSha } }] });
test('exact source suite evidence is reusable only for its actual invocation profile and policy', () => {
  assert.equal(resolveSourceSuiteReuse(summary(), expected), true);
  for (const changed of [{ runId: '124' }, { sourceSha: 'b'.repeat(40) }, { profile: 'stable' }, { policy: 'production' }, { suite: 'binary-smoke' }]) {
    assert.equal(resolveSourceSuiteReuse(summary(), { ...expected, ...changed }), false);
  }
});
test('generic green, skipped command, missing Binary Smoke and failed summaries never substitute for suite evidence', () => {
  const generic = summary(); generic.lanes[0].outputs = {};
  assert.equal(resolveSourceSuiteReuse(generic, expected), false);
  const skipped = summary(); skipped.lanes[0].result = 'skipped';
  assert.equal(resolveSourceSuiteReuse(skipped, expected), false);
  const failed = summary(); failed.failures = ['other'];
  assert.equal(resolveSourceSuiteReuse(failed, expected), false);
  assert.equal(resolveSourceSuiteReuse(summary(), { ...expected, suite: 'binary-smoke' }), false);
  const smoke = summary(); smoke.lanes[0].outputs.source_suite = 'binary-smoke';
  assert.equal(resolveSourceSuiteReuse(smoke, { ...expected, suite: 'binary-smoke' }), true);
});


test('canonical verifier projects proof from its admitted run through the real download boundary', async (t) => {
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const verifier = await import('./verify-existing-ci.mjs');
  const scratch = await mkdtemp(join(tmpdir(), 'happier-proof-verifier-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  // Only GitHub's OS/process boundary is replaced; run and summary admission stay real.
  t.mock.method(childProcess.default, 'spawnSync', (command, args) => {
    if (args[0] === 'api') return { status: 0, stdout: JSON.stringify({
      id: 123, path: '.github/workflows/tests.yml', head_sha: expected.sourceSha,
      head_branch: 'dev', event: 'push', head_repository: { full_name: 'happier-dev/happier' },
      status: 'completed', conclusion: 'success' }), stderr: '' };
    const directory = args[args.indexOf('--dir') + 1];
    requireWrite(directory);
    return { status: 0, stdout: '', stderr: '' };
  });
  const { writeFileSync } = await import('node:fs');
  const requireWrite = (directory) => writeFileSync(join(directory, 'ci-summary.json'), JSON.stringify(summary()));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const output = join(scratch, 'output');
  const args = ['--repository', 'happier-dev/happier', '--source-sha', expected.sourceSha,
    '--source-branch', 'dev', '--run-id', '123', '--source-profile', 'integrated', '--github-output', output];
  if (verifier.DEFAULT_RELEASE_CI_LANES) args.push('--required-lanes', 'release-contracts');
  await verifier.main(args);
  const projected = await readFile(output, 'utf8');
  assert.match(projected, /^source_contracts_preview=success$/m);
  assert.match(projected, /^source_contracts_production=$/m);
  assert.match(projected, /^binary_smoke_preview=$/m);
});
