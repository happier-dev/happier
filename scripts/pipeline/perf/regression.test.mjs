import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import * as regression from '../../../apps/stack/scripts/perf/regression.mjs';

const counts = { requests: 4, renders: 2, commits: 1, storeNotifications: 1, socketFrames: 2, timers: 0, sqlStatements: 3 };
const run = (mode = 'counts', extra = {}) => ({ version: 5, journey: 'J1', cache: 'warm', uiMode: 'export',
  captureMode: mode, status: 'CAPTURED', durationMs: 100,
  instrumentation: { storeTelemetry: mode === 'counts', fiberHook: mode === 'counts', profiling: false },
  hostBefore: { host: 'one-host' }, counts: { ...counts }, ...extra });
const pair = (baseline = run(), candidate = run()) => ({ baseline, candidate });
const assess = pairs => regression.assessRegressionPairs(pairs, { requiredCounts: Object.keys(counts) });

test('counts reject one real regression even when another pair improves by more', () => {
  const result = assess([pair(), pair(run(), run('counts', { counts: { ...counts, requests: 5 } })),
    pair(run(), run('counts', { counts: { ...counts, requests: 0 } }))]);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.counts.find(row => row.metric === 'requests' && row.delta > 0).delta, 1);
  assert.equal(assess([pair()]).status, 'PASS');
});

test('missing, null and nonfinite counters and incomplete captures cannot become zero', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) {
    const candidate = run('counts', { counts: { ...counts, sqlStatements: value } });
    assert.equal(assess([pair(run(), candidate)]).status, 'BLOCKED');
  }
  assert.equal(assess([pair(run(), run('counts', { status: 'INCOMPLETE' }))]).status, 'BLOCKED');
  assert.equal(assess([]).status, 'BLOCKED');
});

test('unmatched journey, collector, instrumentation and execution host fail closed', () => {
  for (const extra of [{ journey: 'J5' }, { version: 4 }, { cache: 'cold' }, { uiMode: 'dev' },
    { instrumentation: { storeTelemetry: false, fiberHook: false } }, { hostBefore: { host: 'other-host' } }]) {
    assert.equal(assess([pair(run(), run('counts', extra))]).status, 'BLOCKED');
  }
});

test('paired timing ratios alert outside measured baseline spread; heavy profiling is ineligible', () => {
  const pairs = Array.from({ length: 5 }, (_, i) => pair(run('timing', { durationMs: 100 + i }), run('timing', { durationMs: 130 + i })));
  const result = assess(pairs);
  assert.equal(result.status, 'ALERT');
  assert.equal(result.timings[0].noiseRatio, 104 / 100);
  assert.ok(result.timings[0].pairedRatio > result.timings[0].noiseRatio);
  assert.equal(assess(pairs.slice(0, 4)).status, 'BLOCKED');
  assert.equal(assess([pair(run('timing'), run('timing', { instrumentation: { profiling: true } }))]).status, 'BLOCKED');
  const noisy = pairs.map((p, i) => pair({ ...p.baseline, durationMs: 100 + i * 20 }, { ...p.candidate, durationMs: 110 + i * 20 }));
  assert.equal(assess(noisy).status, 'PASS');
});

test('heap slope uses post-GC cycles and alerts on retained growth rather than allocation volume', () => {
  const samples = growth => Array.from({ length: 5 }, (_, cycle) => ({ cycle, usedBytes: 1000 + cycle * growth, forcedGc: true }));
  const result = assess([pair(run('counts', { heap: { samples: samples(0) } }), run('counts', { heap: { samples: samples(100) } }))]);
  assert.equal(result.status, 'ALERT');
  assert.equal(result.heap[0].candidateBytesPerCycle, 100);
  const bad = samples(100); bad[2].forcedGc = false;
  assert.equal(assess([pair(run('counts', { heap: { samples: samples(0) } }), run('counts', { heap: { samples: bad } }))]).status, 'BLOCKED');
});

test('backend capture roles must match and cannot supply unperturbed paired browser timings', () => {
  assert.equal(assess([pair(run(), run('counts', { backendProfileRoles: ['server'] }))]).status, 'BLOCKED');
  assert.equal(assess([pair(run('counts', { backendProfileRoles: ['server', 'daemon'] }),
    run('counts', { backendProfileRoles: ['daemon', 'server'] }))]).status, 'PASS');
  const timings = Array.from({ length: 5 }, () => pair(run('timing', { backendProfileRoles: ['server'] }),
    run('timing', { backendProfileRoles: ['server'] })));
  const result = assess(timings);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.timings.length, 0, 'instrumented paired ratios must not escape the ordinary comparison exclusion');
});

test('production bundle budget measures all emitted JS/CSS once and rejects a real added chunk', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-bundle-' });
  for (const side of ['baseline', 'candidate']) {
    await mkdir(temp.path(side, 'assets'), { recursive: true });
    await writeFile(temp.path(side, 'index.html'), '<script src="assets/app.js"></script>');
    await writeFile(temp.path(side, 'assets/app.js'), 'const app = 1;');
    await writeFile(temp.path(side, 'assets/app.css'), 'body{}');
    await writeFile(temp.path(side, 'assets/app.js.map'), 'not shipped executable code');
    await writeFile(temp.path(side, 'assets/app.js.gz'), 'compressed sidecar');
  }
  const baseline = await regression.readProductionBundleSize(temp.path('baseline'));
  const before = await regression.readProductionBundleSize(temp.path('candidate'));
  assert.equal(baseline.bytes, Buffer.byteLength('const app = 1;body{}'));
  assert.equal(regression.assessBundleBudget(baseline, before).status, 'PASS');
  await writeFile(temp.path('candidate/assets/extra.js'), 'const unused = 2;');
  const after = await regression.readProductionBundleSize(temp.path('candidate'));
  assert.equal(regression.assessBundleBudget(baseline, after).status, 'FAIL');
  assert.equal(regression.assessBundleBudget(baseline, after).deltaBytes, Buffer.byteLength('const unused = 2;'));
  await mkdir(temp.path('empty'));
  await assert.rejects(regression.readProductionBundleSize(temp.path('empty')));
});

// A minimal Metro/Expo web export: the shapes are copied from a real v0.3 export
// (route context getters `(d[N],d.paths)` and a dependency map with `paths`).
const module = body => `__d((function(g,r,i,a,m,e,d){${body}}),1,[]);`;
const chunkPath = (name, asyncCommon) => JSON.stringify(asyncCommon
  ? ['/_expo/static/js/web/__common-e.js', `/_expo/static/js/web/${name}.js`] : `/_expo/static/js/web/${name}.js`);
const route = (key, index) => `"${key}":{enumerable:!0,get:()=>r(d[1])(d[${index}],d.paths)}`;
// Keys keep Expo's order: `./(app)/…` sorts before `./_layout.tsx`.
// `asyncCommon`: the current Metro shape (patches/@expo__metro-config): the shared `__common` chunk is no
// longer an index.html script; each async chunk's path is [prerequisite chunks…, chunk].
async function writeWebExport(root, { entryModules = 2, homeBody = 'home', precompressed = true, asyncCommon = false } = {}) {
  const js = join(root, '_expo/static/js/web');
  await mkdir(join(root, '_expo/static/css'), { recursive: true });
  await mkdir(js, { recursive: true });
  await writeFile(join(root, 'index.html'), '<link href="/_expo/static/css/theme.css" rel="stylesheet">'
    + '<script src="/_expo/static/js/web/runtime.js"></script><script src="/_expo/static/js/web/entry.js"></script>');
  const context = `__d((function(g,r,i,a,m,e,d){m.exports={${[route('./(app)/_layout.tsx', 3),
    route('./(app)/index.tsx', 4), route('./(app)/settings/index.tsx', 5), route('./_layout.tsx', 2)].join(',')}}}),2,{"0":0,"1":7,"2":10,"3":11,"4":12,"5":13,`
    + `"paths":{${['_layout-a', '_layout-b', 'index-c', '[id]-d'].map((name, index) => `"${10 + index}":${chunkPath(name, asyncCommon)}`).join(',')}}});`;
  const files = {
    '_expo/static/css/theme.css': 'body{color:red}',
    '_expo/static/js/web/runtime.js': 'var __d;',
    '_expo/static/js/web/entry.js': module('entry').repeat(entryModules) + context,
    '_expo/static/js/web/_layout-a.js': module('root layout'),
    '_expo/static/js/web/_layout-b.js': module('app layout'),
    '_expo/static/js/web/index-c.js': module(homeBody),
    '_expo/static/js/web/[id]-d.js': module('settings is not before Home').repeat(5),
    ...asyncCommon ? { '_expo/static/js/web/__common-e.js': module('shared by every async chunk').repeat(4) } : {},
  };
  for (const [file, text] of Object.entries(files)) {
    await writeFile(join(root, file), text);
    // The precompression owner writes a sidecar only when it is smaller.
    if (precompressed && file !== '_expo/static/js/web/runtime.js') await writeFile(join(root, `${file}.br`), 'x'.repeat(3));
  }
  return files;
}

test('boot weight counts the entry, its styles and the async Home route chunks, never other routes', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-boot-' });
  const files = await writeWebExport(temp.path('base'));
  const boot = await regression.readWebBootWeight(temp.path('base'));
  const beforeHome = ['_expo/static/css/theme.css', '_expo/static/js/web/runtime.js', '_expo/static/js/web/entry.js',
    '_expo/static/js/web/_layout-a.js', '_expo/static/js/web/_layout-b.js', '_expo/static/js/web/index-c.js'];
  assert.deepEqual(boot.files.map(row => row.file), beforeHome);
  // Two entry modules + the route context + one module per Home route chunk.
  assert.equal(boot.modules, 6);
  assert.equal(boot.bytes, beforeHome.reduce((sum, file) => sum + Buffer.byteLength(files[file]), 0));
  // Served bytes: the shipped brotli sidecar, or the raw file when no sidecar was worth writing.
  assert.equal(boot.brotliBytes, 5 * 3 + Buffer.byteLength(files['_expo/static/js/web/runtime.js']));

  await writeWebExport(temp.path('candidate'), { entryModules: 3, homeBody: 'a heavier home route' });
  const candidate = await regression.readWebBootWeight(temp.path('candidate'));
  const size = regression.assessBundleBudget({ bytes: 1, boot }, { bytes: 1, boot: candidate });
  assert.equal(size.status, 'FAIL');
  assert.deepEqual(size.boot.map(row => [row.metric, row.delta]), [
    ['modules before Home', 1],
    ['JS/CSS bytes before Home', candidate.bytes - boot.bytes],
    ['brotli transfer bytes before Home', 0],
  ]);
  assert.match(regression.renderPerfComparison({ status: size.status, bundleSize: size }), /modules before Home \| 6 \| 7 \| 1 /);

  await writeWebExport(temp.path('plain'), { precompressed: false });
  assert.equal((await regression.readWebBootWeight(temp.path('plain'))).brotliBytes, null,
    'an export the precompression owner never ran on has no served-bytes figure');
  await writeFile(temp.path('plain/_expo/static/js/web/entry.js'), module('no router'));
  await assert.rejects(regression.readWebBootWeight(temp.path('plain')), /Home route/);
});

test('boot weight counts the shared common chunk that Home route chunks require once, though index.html does not list it', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-boot-common-' });
  const files = await writeWebExport(temp.path('export'), { asyncCommon: true });
  const boot = await regression.readWebBootWeight(temp.path('export'));
  const beforeHome = ['_expo/static/css/theme.css', '_expo/static/js/web/runtime.js', '_expo/static/js/web/entry.js',
    '_expo/static/js/web/__common-e.js', '_expo/static/js/web/_layout-a.js', '_expo/static/js/web/_layout-b.js', '_expo/static/js/web/index-c.js'];
  assert.deepEqual(boot.files.map(row => row.file), beforeHome);
  assert.equal(boot.files.find(row => row.file.includes('__common')).kind, 'shared');
  assert.equal(boot.modules, 6 + 4);
  assert.equal(boot.bytes, beforeHome.reduce((sum, file) => sum + Buffer.byteLength(files[file]), 0));
});

test('the route table gives every route its own chunk weight and the shared chunks it needs first', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-routes-' });
  for (const asyncCommon of [false, true]) {
    const files = await writeWebExport(temp.path(String(asyncCommon)), { asyncCommon });
    const { routes } = await regression.readWebBootWeight(temp.path(String(asyncCommon)));
    assert.deepEqual(Object.keys(routes), ['./(app)/_layout.tsx', './(app)/index.tsx', './(app)/settings/index.tsx', './_layout.tsx']);
    assert.deepEqual(routes['./(app)/settings/index.tsx'], {
      files: ['_expo/static/js/web/[id]-d.js'], shared: asyncCommon ? ['_expo/static/js/web/__common-e.js'] : [],
      bytes: Buffer.byteLength(files['_expo/static/js/web/[id]-d.js']), brotliBytes: 3, modules: 5,
    });
  }
});

test('comparison summary retains backend CPU, event-loop and long-task observations as noisy deltas', () => {
  const baseline = run('counts', { processWindow: { server: { averageCpuPercent: 10, afterRssBytes: 200 } },
    backendProfiles: { roles: { daemon: { metrics: { delay: { p95: 3 } } } } },
    profiling: { trace: { summary: { maxTaskMs: 50 } } } });
  const candidate = { ...baseline, processWindow: { server: { averageCpuPercent: 20, afterRssBytes: 250 } } };
  const report = assess([pair(baseline, candidate)]);
  const text = regression.renderPerfComparison(report);
  assert.match(text, /averageCpuPercent.*10.*20.*10/);
  assert.match(text, /delay.p95.*3.*3.*0/);
  assert.match(text, /maxTaskMs.*50.*50.*0/);
  assert.match(text, /noisy, informational/);
});

test('comparison shows elapsed capture observations and source availability beside metric deltas', () => {
  const report = { ...assess([pair(run(), run('counts', { durationMs: 120 }))]),
    sources: { baseline: { sha: 'a'.repeat(40), dirty: false }, candidate: { sha: null, dirty: null } },
    baselineComparison: { status: 'HISTORICAL', expectedSha: 'a'.repeat(40) } };
  const elapsed = report.observations.find(row => row.metric === 'durationMs');
  assert.equal(elapsed.before, 100);
  assert.equal(elapsed.after, 120);
  assert.equal(elapsed.delta, 20);
  const text = regression.renderPerfComparison(report);
  assert.match(text, /HISTORICAL/);
  assert.ok(text.includes('a'.repeat(40)));
  assert.match(text, /durationMs.*100.*120.*20/);
  assert.match(text, /candidate source:.*unavailable.*dirty: unavailable/);
});

test('unavailable baseline still displays candidate measurements without inventing deltas', () => {
  const result = assess([{ candidate: run('counts', { processWindow: { server: { averageCpuPercent: 20 } } }) }]);
  assert.equal(result.status, 'BLOCKED');
  const requests = result.counts.find(row => row.metric === 'requests');
  assert.equal(requests.before, null);
  assert.equal(requests.after, 4);
  assert.equal(requests.delta, null);
  assert.match(regression.renderPerfComparison(result), /averageCpuPercent.*unavailable.*20.*unavailable/);
  const size = regression.assessBundleBudget(undefined, { bytes: 100, files: [] });
  assert.equal(size.deltaBytes, null);
  assert.match(regression.renderPerfComparison({ ...result, bundleSize: size }), /emitted JS\/CSS bytes.*unavailable.*100.*unavailable/);
});

test('historical exact-base artifacts compare counts across hosts but never pretend to be paired timings', () => {
  const pairs = Array.from({ length: 5 }, () => ({ ...pair(run('timing'), run('timing', { hostBefore: { host: 'new-runner' } })), historical: true }));
  const timing = assess(pairs);
  assert.equal(timing.timings.length, 0);
  assert.match(timing.gaps.join('\n'), /historical.*not paired/);
  const counts = assess([{ ...pair(run(), run('counts', { hostBefore: { host: 'new-runner' } })), historical: true }]);
  assert.equal(counts.status, 'PASS');
  assert.equal(counts.counts.find(row => row.metric === 'requests').delta, 0);
});

test('footprint shows measured zero, unavailable roles and only compatible informational deltas', () => {
  const capture = (workload, roles) => run('counts', { footprint: { workload, phases: { settled: roles } } });
  const baseline = capture('fake-claude-v1:42', { daemon: { rssBytes: 100, cpuMs: 0 }, holder: null });
  const candidate = capture('fake-claude-v1:42', { daemon: { rssBytes: 120, cpuMs: 0 }, holder: { rssBytes: 10 } });
  const value = (report, metric) => report.observations.find(row => row.metric === `footprint.settled.${metric}`);
  const report = assess([pair(baseline, candidate)]);
  assert.deepEqual([value(report, 'daemon.rssBytes')?.delta, value(report, 'daemon.cpuMs')?.delta], [20, 0]);
  assert.equal(value(report, 'holder.rssBytes').before, null);
  assert.equal(value(report, 'holder.rssBytes').delta, null);
  assert.equal(report.status, 'PASS');
  assert.match(regression.renderPerfComparison(report), /footprint.settled.holder.rssBytes.*unavailable.*10.*unavailable/);

  const mismatched = assess([pair(baseline, capture('fake-claude-v1:43', { daemon: { rssBytes: 120 } }))]);
  assert.equal(value(mismatched, 'daemon.rssBytes').after, 120);
  assert.equal(value(mismatched, 'daemon.rssBytes').delta, null);
  const oldBase = assess([pair(run(), candidate)]);
  assert.equal(value(oldBase, 'daemon.rssBytes').delta, null);
});
