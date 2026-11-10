import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createLoadSentinel, sentinelGraphs, isSentinelSource, watchLoadSentinel } from './load-sentinel.mjs';
import { ENTRY_GRAPHS } from './entry-load.mjs';

async function fixtureGraph(t) {
  const fixture = await createTempFixture(t, { prefix: 'load-sentinel-' });
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await mkdir(fixture.path('apps/cli/scripts'), { recursive: true });
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};');
  const graph = ENTRY_GRAPHS.find(item => item.id === 'protocol-import-cycles');
  const entry = fixture.path(graph.entry);
  await writeFile(entry, 'export {};');
  return { fixture, graph, entry };
}

test('real graph load transitions post one failure and one clear; unchanged failures stay quiet', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.equal(posts.length, 0);
  await writeFile(entry, "throw new ReferenceError(\"Cannot access 'fixtureBinding' before initialization\");");
  await sentinel.request();
  for (let n = 0; n < 3; n++) await sentinel.request();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /URGENT/);
  assert.match(posts[0], /fixtureBinding/);
  assert.match(posts[0], /apps\/cli\/scripts\/importCycleGuard.mjs/);
  await writeFile(entry, 'export {};');
  await sentinel.request();
  await sentinel.request();
  assert.equal(posts.length, 2);
  assert.match(posts[1], /cleared/);
});

test('changes during an active run coalesce into at most one follow-up', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  await writeFile(entry, 'throw new ReferenceError("fixtureMissing is not defined");');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const results = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: t.signal,
    onResult: result => results.push(result),
    post: async () => { entered.resolve(); await release.promise; } });
  const active = sentinel.request();
  await entered.promise;
  for (let n = 0; n < 20; n++) sentinel.request();
  release.resolve();
  await active;
  assert.equal(results.length, 2);
});

test('sentinel subset consumes the canonical graph declarations', () => {
  assert.deepEqual(sentinelGraphs().map(graph => graph.id).sort(),
    ['daemon', 'protocol-import-cycles', 'server', 'ui-catalog']);
  for (const graph of sentinelGraphs()) assert.ok(ENTRY_GRAPHS.includes(graph));
});

test('loader source text and credential-shaped messages never enter board output', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const privateValue = ['Bear', 'er ', 'fixture-private-value'].join('');
  await writeFile(entry, `throw new Error(${JSON.stringify(privateValue)});`);
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.equal(posts.length, 1);
  assert.ok(!posts[0].includes(privateValue), 'raw diagnostic leaked');
});

test('failure attribution follows the real resolved import path and includes its three source mtimes', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  await writeFile(entry, "import './middle.mjs';");
  await writeFile(fixture.path('apps/cli/scripts/middle.mjs'), "import './leaf.mjs';");
  await writeFile(fixture.path('apps/cli/scripts/leaf.mjs'), 'throw new ReferenceError("leafBinding is not defined");');
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.equal(posts.length, 1);
  for (const file of ['importCycleGuard.mjs', 'middle.mjs', 'leaf.mjs']) assert.ok(posts[0].includes(file));
  assert.equal((posts[0].match(/ — \d{4}-\d\d-\d\dT/g) ?? []).length, 3);
  assert.ok(!posts[0].includes('trace incomplete'));
});

test('source selection excludes build and dependency output at every depth', () => {
  for (const path of ['ui/node_modules/example/index.ts', 'cli/dist/index.js', 'ui/.expo/index.js',
    'server/generated/client.ts', '.project/source.ts', 'ui/build/output.json']) assert.equal(isSentinelSource(path), false);
  assert.equal(isSentinelSource('ui/sources/catalog.ts'), true);
  assert.equal(isSentinelSource('cli\\src\\daemon.ts'), true);
  // A directory rename can remove many imported sources with one event.
  assert.equal(isSentinelSource('ui/sources/moved-domain'), true);
});

test('foreground watcher detects a nested fixture edit and stops without leaving a pending check', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  await mkdir(fixture.path('packages/fixture'), { recursive: true });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const posts = [];
  let edit;
  await watchLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: controller.signal,
    onResult: result => {
      if (result.status === 'passed' && !edit) edit = writeFile(entry, 'throw new ReferenceError("watcherBinding is not defined");');
    },
    post: async entry => { posts.push(entry); controller.abort(); },
  });
  await edit;
  assert.equal(posts.length, 1);
  assert.match(posts[0], /watcherBinding/);
});

test('protocol cycle diagnostics identify the eager binding and authored cycle modules', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const { formatGuardFailure } = await import('../../../cli/scripts/importCycleGuard.mjs');
  await mkdir(fixture.path('packages/protocol/src'), { recursive: true });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(fixture.path('packages/protocol/src', name), 'export {};');
  const diagnostic = formatGuardFailure([{ files: ['a.ts', 'b.ts', 'c.ts'],
    edges: [['a.ts', 'b.ts'], ['b.ts', 'c.ts'], ['c.ts', 'a.ts']],
    read: { from: 'a.ts', to: 'b.ts', binding: 'cycleBinding' } }]);
  await writeFile(entry, `console.error(${JSON.stringify(diagnostic)}); process.exitCode = 1;`);
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /symbol=cycleBinding/);
  for (const name of ['a.ts', 'b.ts', 'c.ts']) assert.ok(posts[0].includes(`packages/protocol/src/${name}`));
});

test('UI bundler failures preserve the binding and the resolved authored import path', async t => {
  const { fixture } = await fixtureGraph(t);
  const graph = ENTRY_GRAPHS.find(graph => graph.id === 'ui-catalog');
  await mkdir(fixture.path('apps/ui/sources/agents/catalog'), { recursive: true });
  await writeFile(fixture.path('apps/ui/vitest.config.ts'), 'export default {test:{environment:"node"}};');
  await writeFile(fixture.path(graph.entry), "import './middle';");
  await writeFile(fixture.path('apps/ui/sources/agents/catalog/middle.ts'), "import './leaf';");
  await writeFile(fixture.path('apps/ui/sources/agents/catalog/leaf.ts'), 'throw new ReferenceError("uiBinding is not defined");');
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /symbol=uiBinding/);
  for (const name of ['catalog.test.ts', 'middle.ts', 'leaf.ts']) assert.ok(posts[0].includes(name));
});

test('distinct breaks within one board minute remain distinct notifications until recovery', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T08:00:00Z') });
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  for (const symbol of ['firstBinding', 'secondBinding', 'firstBinding']) {
    await writeFile(entry, `throw new ReferenceError("${symbol} is not defined");`);
    await sentinel.request();
  }
  assert.equal(posts.length, 2, 'an already reported break must stay quiet');
  await writeFile(entry, 'export {};');
  await sentinel.request();
  assert.equal(posts.length, 4, 'each observed break gets one confirmed clear');
  assert.equal(new Set(posts.map(post => post.split('\n')[0])).size, 4, 'board watchers deduplicate on complete headings');
});

test('a missing exported binding reports its symbol through the real loader', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  await writeFile(entry, "import { absentBinding } from './leaf.mjs'; console.log(absentBinding);");
  await writeFile(fixture.path('apps/cli/scripts/leaf.mjs'), 'export {};');
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph],
    signal: t.signal, post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /symbol=absentBinding/);
  assert.match(posts[0], /importing module=apps\/cli\/scripts\/importCycleGuard.mjs/);
});
