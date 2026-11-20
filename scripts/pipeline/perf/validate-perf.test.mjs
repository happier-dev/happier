import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import * as perf from './validate-perf.mjs';

test('default validation covers every required journey and interleaves paired runs on one host', () => {
  const plan = perf.resolvePerfValidationPlan({ baselineRef: 'HEAD~1', out: '/tmp/perf-proof' });
  const groups = new Set(plan.runs.map(run => `${run.journey}/${run.cache}`));
  for (const key of ['J1/cold', 'J1/warm', 'J13/warm', 'J4-stream/warm', 'J5/warm', 'J14/warm', 'Stop/warm']) assert.ok(groups.has(key), key);
  assert.ok(plan.runs.some(run => run.mode === 'counts'));
  assert.ok(plan.runs.some(run => run.mode === 'timing'));
  const pairs = Map.groupBy(plan.runs, run => run.pairId);
  for (const runs of pairs.values()) {
    assert.equal(runs.length, 2);
    assert.deepEqual(new Set(runs.map(run => run.side)), new Set(['baseline', 'candidate']));
    assert.equal(runs[0].journey, runs[1].journey);
    assert.equal(runs[0].cache, runs[1].cache);
    assert.equal(runs[0].mode, runs[1].mode);
  }
  const j1 = plan.runs.filter(run => run.journey === 'J1' && run.cache === 'cold' && run.mode === 'timing');
  assert.equal(j1.length, 10, 'five timing repeats per side are the existing harness minimum');
  assert.deepEqual(j1.slice(0, 4).map(run => run.side), ['baseline', 'candidate', 'candidate', 'baseline']);
});

test('invalid input fails before environment mutation and dry run never starts the suite', () => {
  for (const options of [{}, { baselineRef: '--help' }, { baselineRef: 'HEAD', repeats: 4 }, { baselineRef: 'HEAD', repeats: 5.5 }]) {
    assert.throws(() => perf.resolvePerfValidationPlan(options));
  }
});

test('comparison callers place detached bases outside the synced checkout', async () => {
  const { computeDetachedWorktreeDir } = await import('../../../apps/stack/scripts/utils/review/detached_worktree.mjs');
  const dir = computeDetachedWorktreeDir({ repoRootDir: '/repo', worktreesRoot: '/tmp/happier-perf-bases',
    label: 'baseline', headCommit: 'abcdef0123456789', nonce: 'one' });
  assert.equal(dir, '/tmp/happier-perf-bases/baseline-abcdef012345-one');
});

test('a Git-free worker mirror captures authored runtime and stress inputs, never dependencies or retained data', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-mirror-' });
  const files = {
    'package.json': '{}', 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': '',
    'packages/tests/package.json': '{"name":"@happier-dev/tests"}',
    'packages/tests/src/testkit/stress/cli/runPerfJourney.ts': 'export {};',
    'packages/tests/src/fixtures/fake-claude-code-cli.js': 'export {};',
    'packages/tests/baselines/provider.json': '{}',
    '.github/feature-policy/default.json': '{}',
    'patches/fixture.patch': 'fixture',
    'apps/stack/bin/hstack-exec': '#!/bin/sh\n',
    'apps/cli/tools/archives/difftastic-x64-linux.tar.gz': 'archive fixture',
    'node_modules/private/package.json': '{}', '.happier/private-account.json': '{}',
  };
  for (const [path, value] of Object.entries(files)) {
    const target = temp.path('mirror', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  }
  const basis = await perf.capturePerfSourceBasis({ source: temp.path('mirror'), captured: temp.path('private') });
  assert.equal(await readFile(temp.path('private/packages/tests/src/testkit/stress/cli/runPerfJourney.ts'), 'utf8'), 'export {};');
  assert.equal(await readFile(temp.path('private/packages/tests/baselines/provider.json'), 'utf8'), '{}');
  for (const path of ['packages/tests/src/fixtures/fake-claude-code-cli.js', '.github/feature-policy/default.json', 'patches/fixture.patch', 'apps/stack/bin/hstack-exec', 'apps/cli/tools/archives/difftastic-x64-linux.tar.gz']) {
    assert.equal(await readFile(temp.path('private', path), 'utf8'), files[path]);
  }
  for (const path of ['node_modules/private/package.json', '.happier/private-account.json']) {
    await assert.rejects(readFile(temp.path('private', path)), { code: 'ENOENT' });
  }
  assert.equal(basis.sha, null);
  assert.equal(basis.dirty, null, 'unknown provenance must not become a trusted clean-SHA artifact');
  assert.equal(basis.owned, true);
});

test('setup failure writes the same informational comparison files without implying successful collection', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-unavailable-' });
  await mkdir(temp.path('not-a-checkout'));
  const report = await perf.runPerfValidation({ baselineRef: 'HEAD', baselineDir: temp.path('not-a-checkout'),
    candidateDir: temp.path('not-a-checkout'), out: temp.path('output'), profile: 'pr' });
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.informational, true);
  const json = JSON.parse(await readFile(join(temp.path('output'), 'comparison.json'), 'utf8'));
  const markdown = await readFile(join(temp.path('output'), 'comparison.md'), 'utf8');
  assert.equal(json.status, 'INCOMPLETE');
  assert.match(markdown, /INCOMPLETE/);
  assert.match(markdown, /Collection unavailable/);
  assert.ok(json.elapsedMs >= 0);
});

test('PR and baseline producers repeat J4 for measured footprint spread without adding the five-minute idle timing journey to PRs', () => {
  const pr = perf.resolvePerfValidationPlan({ baselineRef: 'HEAD', profile: 'pr' });
  assert.equal(pr.runs.length, 6);
  assert.deepEqual(pr.runs.filter(run => run.journey === 'J4-stream').map(run => [run.side, run.repeat]),
    [['baseline', 0], ['candidate', 0], ['candidate', 1], ['baseline', 1]]);
  assert.ok(pr.runs.every(run => run.mode === 'counts'));
  const full = perf.resolvePerfValidationPlan({ baselineRef: 'HEAD' });
  assert.equal(full.runs.filter(run => run.journey === 'J13').length, 2);
  const candidate = perf.resolvePerfValidationPlan({ baselineRef: 'HEAD', profile: 'pr', candidateOnly: true });
  assert.equal(candidate.runs.length, 3);
  const producer = perf.resolvePerfValidationPlan({ baselineRef: 'HEAD', profile: 'full', candidateOnly: true });
  assert.deepEqual(producer.runs.filter(run => run.journey === 'J4-stream').map(run => run.repeat), [0, 1]);
  assert.ok(candidate.runs.every(run => run.side === 'candidate'));
  assert.throws(() => perf.resolvePerfValidationPlan({ baselineRef: 'HEAD', candidateOnly: true, baselineResultsDir: '/tmp/base' }));
});

test('artifact baselines accept exact source and relative canonical bundles, rejecting source and path substitution', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-artifact-' });
  const sha = 'a'.repeat(40);
  const pairId = 'J1-warm-counts-0';
  const directory = `runs/${pairId}/candidate`;
  await mkdir(temp.path(directory), { recursive: true });
  const bundle = { version: 5, journey: 'J1', cache: 'warm', captureMode: 'counts', counts: { requests: 4 }, status: 'CAPTURED' };
  await writeFile(temp.path(directory, 'bundle.json'), JSON.stringify(bundle));
  const report = { sources: { candidate: { sha, dirty: false } }, bundles: [{ side: 'candidate', pairId, directory,
    journey: 'J1', cache: 'warm', mode: 'counts', repeat: 0 }] };
  await writeFile(temp.path('comparison.json'), JSON.stringify(report));
  const result = await perf.loadPerfBaselineResults(temp.root, sha);
  assert.equal(result.bundles.get(pairId).counts.requests, 4);
  await assert.rejects(perf.loadPerfBaselineResults(temp.root, 'b'.repeat(40)));
  bundle.counts.requests = -1;
  await writeFile(temp.path(directory, 'bundle.json'), JSON.stringify(bundle));
  await assert.rejects(perf.loadPerfBaselineResults(temp.root, sha));
  bundle.counts.requests = 4;
  await writeFile(temp.path(directory, 'bundle.json'), JSON.stringify(bundle));
  report.bundles[0].directory = '../outside';
  await writeFile(temp.path('comparison.json'), JSON.stringify(report));
  await assert.rejects(perf.loadPerfBaselineResults(temp.root, sha));
});
