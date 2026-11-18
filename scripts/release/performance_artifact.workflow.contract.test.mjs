import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import * as workflow from '../pipeline/perf/run-workflow.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

const baseSha = 'a'.repeat(40);
const repository = 'happier-dev/happier';
const run = (override = {}) => ({ id: 12, path: '.github/workflows/performance.yml', event: 'push', status: 'completed', conclusion: 'success', head_sha: baseSha, head_branch: 'dev', repository: { full_name: repository }, head_repository: { full_name: repository }, ...override });
const artifact = (override = {}) => ({ id: 34, name: 'performance-results', expired: false, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 12, head_sha: baseSha }, ...override });

test('baseline artifact selection requires the exact SHA and a successful trusted branch producer', () => {
  const wrong = [run({ id: 99, head_sha: 'c'.repeat(40) }), run({ id: 98, event: 'pull_request' }), run({ id: 97, head_branch: 'feature' }), run({ id: 96, conclusion: 'failure' }), run({ id: 95, head_repository: { full_name: 'attacker/fork' } })];
  assert.equal(workflow.selectExactBaseRun?.([...wrong, run()], { baseSha, repository })?.id, 12);
  // v0.3 pushes produce bases for pull requests into v0.3.
  assert.equal(workflow.selectExactBaseRun?.([...wrong, run({ id: 11, head_branch: 'v0.3' })], { baseSha, repository })?.id, 11);
  assert.equal(workflow.selectExactBaseRun?.(wrong, { baseSha, repository }), null, 'never use an unlabelled latest fallback');
  assert.equal(workflow.selectPerformanceArtifact?.([artifact()], { baseSha, runId: 12 })?.id, 34);
  for (const invalid of [artifact({ expired: true }), artifact({ digest: undefined }), artifact({ workflow_run: { id: 99, head_sha: baseSha } }), artifact({ workflow_run: { id: 12, head_sha: 'd'.repeat(40) } })]) {
    assert.equal(workflow.selectPerformanceArtifact?.([invalid], { baseSha, runId: 12 }), null);
  }
});

test('artifact ingestion admits only exact-source candidate JSON bundle paths', () => {
  const report = { sources: { candidate: { sha: baseSha, dirty: false } }, bundles: [
    { side: 'candidate', pairId: 'J1-warm-counts-0', directory: '/old/runner/runs/J1-warm-counts-0/candidate' },
    { side: 'baseline', pairId: 'J1-warm-counts-0', directory: '/old/runner/runs/J1-warm-counts-0/baseline' },
  ] };
  assert.deepEqual(workflow.baselineBundleEntries?.(report, baseSha), [{ entry: 'runs/J1-warm-counts-0/candidate/bundle.json', directory: 'runs/J1-warm-counts-0/candidate' }]);
  assert.throws(() => workflow.baselineBundleEntries?.({ ...report, sources: { candidate: { sha: 'e'.repeat(40), dirty: false } } }, baseSha));
  assert.throws(() => workflow.baselineBundleEntries?.({ ...report, bundles: [{ side: 'candidate', pairId: '../../script', directory: '/tmp' }] }, baseSha));
  assert.throws(() => workflow.baselineBundleEntries?.({ ...report, sources: { candidate: { sha: baseSha, dirty: true } } }, baseSha));
});

test('ZIP ingestion materializes canonical JSON data and never extracts artifact executables', async t => {
  const { root: scratch } = await createTempFixture(t, { prefix: 'happier-performance-artifact-' });
  const directory = 'runs/J1-warm-counts-0/candidate';
  const bundle = { version: 4, counts: { requests: 3 } };
  const archive = join(scratch, 'artifact.zip');
  // Generated with Info-ZIP `zip -X` from the bundle/report below and a throwing
  // untrusted-code.mjs. Keep real archive ingestion independent of a ZIP writer.
  await writeFile(archive, Buffer.from('UEsDBBQACAAIAMSVVl0AAAAAAAAAACYAAAArAAAAcnVucy9KMS13YXJtLWNvdW50cy0wL2NhbmRpZGF0ZS9idW5kbGUuanNvbqtWKkstKs7Mz1OyMtFRSs4vzSspVrKqVipKLSxNLQaxjWtruQBQSwcI9x46XyUAAAAmAAAAUEsDBBQACAAIAMSVVl0AAAAAAAAAALIAAAAPAAAAY29tcGFyaXNvbi5qc29ujc0xDkIhEATQ3mNMDfnacgO9grFY2TWSIJhdiDE/3F1+bCydbqZ4s8Jq1yiGsCJS4cTUZCt2JwTQn4EDJ21vhBtlkzEcrr1w3uDzxBJP9OfA4UlJjzzH08G/SB8+1l6a+f2XktiqTg5LzbxoL0UU4zJ2H1BLBwjvkK1GcwAAALIAAABQSwMEFAAIAAgAxJVWXQAAAAAAAAAAJgAAABIAAAB1bnRydXN0ZWQtY29kZS5tanMrySjKL1fISy1XcC0qyi/SUMotLS4B8stSixRSK1KTS0tSlTS5AFBLBwjP+Z52JgAAACYAAABQSwECHgMUAAgACADElVZd9x46XyUAAAAmAAAAKwAAAAAAAAABAAAAtIEAAAAAcnVucy9KMS13YXJtLWNvdW50cy0wL2NhbmRpZGF0ZS9idW5kbGUuanNvblBLAQIeAxQACAAIAMSVVl3vkK1GcwAAALIAAAAPAAAAAAAAAAEAAAC0gX4AAABjb21wYXJpc29uLmpzb25QSwECHgMUAAgACADElVZdz/mediYAAAAmAAAAEgAAAAAAAAABAAAAtIEuAQAAdW50cnVzdGVkLWNvZGUubWpzUEsFBgAAAAADAAMA1gAAAJQBAAAAAA==', 'base64'));
  const out = join(scratch, 'baseline');
  assert.equal(await workflow.materializePerformanceArtifact?.({ archive, out, baseSha }), out);
  assert.deepEqual(JSON.parse(await readFile(join(out, directory, 'bundle.json'), 'utf8')), bundle);
  const report = JSON.parse(await readFile(join(out, 'comparison.json'), 'utf8'));
  assert.equal(report.bundles[0].directory, directory);
  assert.equal(existsSync(join(out, 'untrusted-code.mjs')), false);
});

test('PR workflow provenance uses the exact base SHA rather than substituting its merge-base', async t => {
  const { root: scratch } = await createTempFixture(t, { prefix: 'happier-performance-provenance-' });
  await writeFile(join(scratch, 'git'), `#!${process.execPath}\nconst a=process.argv.slice(2); process.stdout.write(a[0]==='diff'?'docs/readme.md\\0':a[0]==='merge-base'?'${'c'.repeat(40)}':'${'b'.repeat(40)}');\n`, { mode: 0o755 });
  const event = join(scratch, 'event.json');
  await writeFile(event, JSON.stringify({ pull_request: { base: { sha: baseSha }, labels: [{ name: 'performance' }] } }));
  const result = spawnSync(process.execPath, ['scripts/pipeline/perf/run-workflow.mjs', '--plan'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', env: { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH}`, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).baseline, baseSha);
  const planned = spawnSync(process.execPath, ['scripts/pipeline/perf/run-workflow.mjs'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', env: { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH}`, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, PERF_DRY_RUN: 'true' } });
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /Baseline comparison UNAVAILABLE/);
  const report = JSON.parse(planned.stdout.slice(planned.stdout.indexOf('{')));
  assert.equal(report.baselineRef, baseSha);
  assert.equal(report.candidateOnly, true);
  assert.equal(report.profile, 'pr');
  assert.ok(report.runs.length > 0);
  assert.ok(report.runs.every(row => row.side === 'candidate'), 'missing artifact must never rebuild the base');
});
