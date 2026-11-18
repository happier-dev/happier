import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { shouldRunPerformance } from '../pipeline/perf/run-workflow.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

const root = new URL('../../', import.meta.url);
const workflow = async (name) => parse(await readFile(new URL(`.github/workflows/${name}`, root), 'utf8'));

test('admission selects labelled fork PRs and hot paths, and skips unrelated changes', () => {
  const event = { pull_request: { labels: [], head: { repo: { fork: true } } } };
  assert.equal(shouldRunPerformance({ eventName: 'pull_request', event, changedPaths: ['docs/readme.md'] }), false);
  assert.equal(shouldRunPerformance({ eventName: 'pull_request', event, changedPaths: ['apps/ui/sources/sync/store/domains/sessions.ts'] }), true);
  assert.equal(shouldRunPerformance({ eventName: 'pull_request', event: { pull_request: { labels: [{ name: 'performance' }] } }, changedPaths: [] }), true);
  assert.equal(shouldRunPerformance({ eventName: 'schedule', event: {}, changedPaths: [] }), true);
  assert.equal(shouldRunPerformance({ eventName: 'push', event: {}, changedPaths: [] }), true);
  assert.equal(shouldRunPerformance({ eventName: 'workflow_dispatch', event: {}, changedPaths: [], release: true }), true);
  assert.throws(() => shouldRunPerformance({ eventName: 'pull_request_target', event: {}, changedPaths: [] }), /Unsupported/);
});

test('public performance command documents its local and release contract without secrets', () => {
  const result = spawnSync(process.execPath, ['scripts/pipeline/run.mjs', 'perf-validate', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--baseline-ref', '--candidate-ref', '--baseline-results-dir', '--candidate-only', '--out', '--repeats', '--dry-run', '--release']) assert.ok(result.stdout.includes(flag), flag);
  assert.equal(result.stdout.includes('--accept-alerts'), false);
});

test('hosted collection consumes the same public pipeline command as the maintainer adapter', async () => {
  const source = await readFile(new URL('scripts/pipeline/perf/run-workflow.mjs', root), 'utf8');
  assert.ok(source.includes("execFileSync(process.execPath, [path.join(root, 'scripts/pipeline/run.mjs'), 'perf-validate', ...args]"), 'hosted collection must consume the public pipeline entrypoint');
});

test('performance workflow admits fork PR labels and hot paths with no write authority', async () => {
  const source = await workflow('performance.yml');
  assert.ok(source.on.schedule.length);
  assert.ok(source.on.pull_request.types.includes('labeled'));
  assert.equal(source.on.pull_request_target, undefined);
  assert.deepEqual(source.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(source.on.push.branches, ['dev', 'main', 'v0.3']);
  assert.equal(source.jobs.performance['runs-on'], 'ubuntu-24.04');
  assert.equal(source.jobs.performance['continue-on-error'], true);
  const checkout = source.jobs.performance.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.match(checkout.with.ref, /pull_request\.head\.sha/);
  const run = source.jobs.performance.steps.find((step) => step.name === 'Run performance comparison');
  assert.equal(run.run, 'node scripts/pipeline/perf/run-workflow.mjs');
  assert.equal(run.env?.GH_TOKEN, '${{ github.token }}');
  const json = source.jobs.performance.steps.find((step) => step.name === 'Upload reusable performance JSON');
  assert.equal(json.with.name, 'performance-results');
  assert.equal(json.with['include-hidden-files'], true);
  assert.match(json.with.path, /comparison\.json/);
  assert.match(json.with.path, /runs\/\*\*\/bundle\.json/);
  assert.equal(source.jobs.performance.steps.find((step) => step.name === 'Upload comparison and profiles').with['include-hidden-files'], true);
});

test('informational release metrics run beside publication without becoming a release gate', async () => {
  const source = await workflow('release-source-validation.yml');
  assert.equal(source.jobs.performance, undefined);
  assert.equal(source.jobs.results.needs.includes('performance'), false);
  const release = await workflow('release.yml');
  assert.equal(release.jobs.performance.uses, './.github/workflows/performance-release.yml');
  assert.equal(release.jobs.performance.with.source_sha, '${{ needs.release_preflight.outputs.source_sha }}');
  assert.deepEqual(release.jobs.performance.needs, ['release_preflight']);
  for (const [name, job] of Object.entries(release.jobs)) {
    if (name === 'performance') continue;
    assert.equal([job.needs].flat().includes('performance'), false, `${name} must not wait for informational metrics`);
  }
  const nightly = await workflow('nightly-dev.yml');
  assert.equal(nightly.jobs.verify_source_ci.needs.includes('performance'), false);
  assert.equal(nightly.jobs.performance.uses, './.github/workflows/performance-release.yml');
  const perf = await workflow('performance-release.yml');
  assert.equal(perf.jobs.performance['runs-on'], 'ubuntu-24.04');
  assert.equal(perf.jobs.performance['continue-on-error'], true);
  assert.deepEqual(perf.permissions, { contents: 'read' });
  assert.equal(perf.jobs.performance.steps.find((step) => step.name === 'Run release performance check').run, 'node scripts/pipeline/perf/run-workflow.mjs --release');
  for (const item of [perf, await workflow('performance.yml')]) {
    const summary = item.jobs.performance.steps.find((step) => step.name === 'Publish performance summary');
    assert.ok(summary.if.includes('always()'));
    assert.equal(summary.run, 'node scripts/pipeline/perf/run-workflow.mjs --summary');
  }
});

test('CI summary consumes the canonical comparison Markdown and marks missing evidence incomplete', async t => {
  const { root: out } = await createTempFixture(t, { prefix: 'happier-performance-summary-' });
  const summary = join(out, 'summary.md');
  const run = () => spawnSync(process.execPath, ['scripts/pipeline/perf/run-workflow.mjs', '--summary', '--out', out], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(run().status, 0);
  assert.match(await readFile(summary, 'utf8'), /INCOMPLETE/);
  const report = '# Performance comparison\n\nInformational measurements.\n';
  await writeFile(join(out, 'comparison.md'), report);
  await writeFile(summary, '');
  assert.equal(run().status, 0);
  assert.equal(await readFile(summary, 'utf8'), report);
});
