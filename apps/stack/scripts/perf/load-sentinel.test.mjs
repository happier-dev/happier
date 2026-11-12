import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../packages/cli-common/fileChangeObserver.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createLoadSentinel, sentinelGraphs, isSentinelSource, watchLoadSentinel } from './load-sentinel.mjs';
import { ENTRY_GRAPHS } from './entry-load.mjs';
import { postBoardEntry } from '../../../../scripts/board/postBoardEntry.mjs';

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
  assert.match(posts[1], /— RESULT —/);
  assert.doesNotMatch(posts[1], /URGENT/);
});

test('real board writer accepts the sentinel break and cleared RESULT', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const board = fixture.path('HANDOFF.md');
  const postFile = fixture.path('notice.md');
  await writeFile(board, '# Fixture board\n');
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: t.signal,
    post: async notice => {
      await writeFile(postFile, notice);
      await postBoardEntry(board, postFile);
    } });
  await writeFile(entry, 'throw new ReferenceError("boardBinding is not defined");');
  await sentinel.request();
  await writeFile(entry, 'export {};');
  await sentinel.request();
  await sentinel.request();
  const published = await readFile(board, 'utf8');
  assert.equal((published.match(/— URGENT —/g) ?? []).length, 1);
  assert.equal((published.match(/— RESULT —/g) ?? []).length, 1);
});

for (const failedState of ['broken', 'cleared']) test(`a failed ${failedState} board write preserves announced state and sampling`, async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const published = [];
  const diagnostics = [];
  t.mock.method(console, 'error', line => diagnostics.push(JSON.parse(line)));
  let rejected = false;
  let attempts = 0;
  let probes = 0;
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: t.signal,
    onResult: () => { probes++; },
    post: async notice => {
      attempts++;
      if (!rejected && notice.includes(` ${failedState} [`)) {
        rejected = true;
        throw Object.assign(new Error('private filesystem diagnostic'), { code: 'EACCES' });
      }
      published.push(notice);
    } });
  await writeFile(entry, 'throw new ReferenceError("retryBinding is not defined");');
  await sentinel.request();
  if (failedState === 'cleared') await writeFile(entry, 'export {};');
  else assert.equal(published.length, 0);
  await sentinel.request();
  await sentinel.request();
  const afterRetry = attempts;
  const probesAfterRetry = probes;
  await sentinel.request();
  assert.equal(attempts, afterRetry, 'successful retry is deduplicated');
  assert.ok(probes > probesAfterRetry, 'sampling continues after publication failure');
  assert.equal(published.filter(notice => notice.includes(` ${failedState} [`)).length, 1);
  assert.deepEqual(diagnostics, [{ event: 'load-sentinel-board-write-failed', graph: graph.id,
    state: failedState, code: 'EACCES' }]);
});

test('a transient real graph failure that passes confirmation publishes nothing', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  await writeFile(entry, 'throw new ReferenceError("transientBinding is not defined");');
  const posts = [];
  const results = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: t.signal,
    onResult: async result => {
      results.push(result.status);
      if (results.length === 1) await writeFile(entry, 'export {};');
    },
    post: async entry => posts.push(entry) });
  await sentinel.request();
  assert.deepEqual(results, ['failed', 'passed']);
  assert.equal(posts.length, 0);
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
  assert.equal(results.length, 3, 'initial failure, confirmation, and one coalesced follow-up');
});

test('source changes renew the confirmation quiet window and a transient watcher break stays silent', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  await writeFile(entry, 'throw new ReferenceError("transientWatcherBinding is not defined");');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const posts = [];
  let edit;
  let quietAfterEdit = false;
  let quietMarker;
  let passedAfterQuiet;
  let probes = 0;
  await watchLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: controller.signal,
    onResult: result => {
      probes++;
      if (probes === 1) edit = (async () => {
        await delay(DEFAULT_FILE_CHANGE_CATCH_UP_MS / 2);
        // This marker settles before the observer's renewed quiet window.
        quietMarker = delay(DEFAULT_FILE_CHANGE_CATCH_UP_MS).then(() => { quietAfterEdit = true; });
        await writeFile(entry, 'export {};');
      })();
      if (result.status === 'passed') { passedAfterQuiet = quietAfterEdit; controller.abort(); }
    },
    post: async entry => posts.push(entry),
  });
  await edit;
  await quietMarker;
  assert.equal(passedAfterQuiet, true, 'confirmation ran before a full source-change-quiet window');
  assert.equal(posts.length, 0);
  assert.equal(probes, 2, 'only the failed graph is confirmed before shutdown');
});

test('sentinel subset consumes the canonical graph declarations', () => {
  assert.deepEqual(sentinelGraphs().map(graph => graph.id).sort(),
    ['bundled-plugin-manifests', 'daemon', 'protocol-import-cycles', 'schema-sync', 'sdk-publication-spec', 'server', 'tracked-migrations', 'ui-catalog', 'ui-web-bundle']);
  for (const graph of sentinelGraphs().filter(graph => ENTRY_GRAPHS.some(entry => entry.id === graph.id))) assert.ok(ENTRY_GRAPHS.includes(graph));
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

test('canonical static protocol guard detects the machine-recipe eager-read edge without evaluating source', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const { copyFile, symlink } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const { dirname } = await import('node:path');
  const require = createRequire(new URL('../../../cli/package.json', import.meta.url));
  await symlink(dirname(require.resolve('typescript/package.json')), fixture.path('node_modules/typescript'), 'junction');
  for (const name of ['importCycleGuard.mjs', 'importCycleEvaluation.mjs']) {
    await copyFile(new URL(`../../../cli/scripts/${name}`, import.meta.url), fixture.path('apps/cli/scripts', name));
  }
  const root = fixture.path('packages/protocol/src');
  await mkdir(root, { recursive: true });
  const config = fixture.path('packages/protocol/tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src/**/*.ts'] }));
  const writeCycle = async eager => {
    for (const [name, imported, binding, exported] of [
      ['machineRecipeV1', 'machineFirewallV1', 'firewall', 'canonicalRecipeSchema'],
      ['machineFirewallV1', 'contributions', 'contributions', 'firewall'],
      ['contributions', 'machineRecipeV1', 'canonicalRecipeSchema', 'contributions'],
    ]) await writeFile(`${root}/${name}.ts`, `import { ${binding} } from './${imported}';
throw new Error('static fixture must never execute');
export const ${exported} = ${eager ? `{ value: ${binding} }` : `() => ${binding}`};`);
  };
  const checkedGraph = { ...graph, args: ['--protocol', '--source-root', root, '--tsconfig', config,
    '--baseline', fixture.path('empty-baseline.json')] };
  const posts = [], results = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [checkedGraph], signal: t.signal,
    waitForQuiet: async () => {}, post: async notice => posts.push(notice), onResult: result => results.push(result) });
  await writeCycle(false);
  await sentinel.request();
  assert.equal(results.at(-1).status, 'passed', 'static imports with deferred reads must not be evaluated');
  await writeCycle(true);
  await sentinel.request();
  assert.equal(results.at(-1).status, 'failed');
  assert.equal(results.at(-1).loadError.code, 'runtime_import_cycle');
  assert.equal(posts.length, 1);
  for (const name of ['machineRecipeV1.ts', 'machineFirewallV1.ts', 'contributions.ts']) assert.ok(posts[0].includes(name));
  await sentinel.request();
  assert.equal(posts.length, 1);
  await writeCycle(false);
  await sentinel.request();
  assert.equal(results.at(-1).status, 'passed');
  assert.equal(posts.length, 2);
  assert.match(posts[1], /cleared/);
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

// OS-temp source, real Expo Babel transform, real HTTP; no shared source mutation.
test('web bundle catches Metro-only declare failure, deduplicates, and clears repair', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const uiDir = fileURLToPath(new URL('../../../ui/', import.meta.url));
  const { once } = await import('node:events');
  const source = fixture.path('packages/cli-common/controllerErrors.ts');
  await writeFile(source, 'export class ControllerError extends Error {\n declare readonly cause?: Error;\n}');
  const require = createRequire(new URL('../../../ui/package.json', import.meta.url));
  const config = require('./metro.config.js');
  const transformer = require(config.transformer.babelTransformerPath);
  const resolverSource = fixture.path('resolve-package.mjs');
  await writeFile(resolverSource, "import { createRequire } from 'node:module'; createRequire(import.meta.url).resolve('@happier-dev/protocol/package.json');");
  const { probeRuntimeImport } = await import('../utils/proc/runtimeImportProbe.mjs');
  let requests = 0;
  let mode = 'bundle';
  const server = createServer(async (req, res) => {
    if (req.url === '/status') return res.end('packager-status:running');
    if (req.url === '/') return res.end('<script src="/fixture.bundle?platform=web&amp;dev=true"></script>');
    requests++;
    if (mode === 'malformed') { res.writeHead(500); return res.end('invalid'); }
    try {
      if (mode === 'exports') {
        // Package export maps are cached by Node. A fresh resolver observes each
        // fixture edit, just as a restarted consumer would.
        const resolved = await probeRuntimeImport({ entrypoint: resolverSource, signal: t.signal });
        if (resolved.status === 'failed') throw new Error('Package export resolution failed');
      }
      await transformer.transform({ filename: source, src: await readFile(source, 'utf8'), plugins: [],
        options: { ...config.transformer, projectRoot: uiDir, platform: 'web',
          dev: true, type: 'module', experimentalImportSupport: false,
          customTransformOptions: { routerRoot: './sources/app' } } });
      res.end('/* bundle */');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      // Babel omits loc for this exact incident. Metro's generic wrapper then
      // publishes lineNumber=0 and puts the filename/code frame in description.
      const WorkerFarm = require('metro/private/DeltaBundler/WorkerFarm').default;
      const format = require('metro/private/lib/formatBundlingError').default;
      res.end(JSON.stringify(format(WorkerFarm.prototype._formatGenericError(error, source))));
    }
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_STACK: 'main' };
  await mkdir(fixture.path('stacks/main'), { recursive: true });
  await writeFile(fixture.path('stacks/main/stack.runtime.json'), JSON.stringify({
    expo: { port: server.address().port, webEnabled: true } }));
  const { pathToFileURL } = await import('node:url');
  await writeFile(entry, `await import(${JSON.stringify(pathToFileURL(source).href)});`);
  // Exercise the four existing loader branches on the same temporary source.
  const oldGraphs = sentinelGraphs().filter(g => g.id !== 'bundled-plugin-manifests' && ENTRY_GRAPHS.some(entry => entry.id === g.id))
    .map(g => ({ ...graph, id: g.id, args: [] }));
  const posts = [], results = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, env,
    graphs: [...oldGraphs, ...sentinelGraphs().filter(g => g.id === 'ui-web-bundle')],
    signal: t.signal, waitForQuiet: async () => {},
    post: async value => posts.push(value), onResult: result => results.push(result) });
  await sentinel.request();
  assert.deepEqual(results.slice(0, 4).map(result => result.status), Array(4).fill('passed'));
  assert.equal(posts.length, 1, 'Metro-only syntax failure was missed');
  assert.match(posts[0], /packages\/cli-common\/controllerErrors.ts:2/);
  assert.doesNotMatch(posts[0], /declare readonly/);
  assert.equal(requests, 2, 'only the failed bundle is confirmed');
  await sentinel.request();
  assert.equal(posts.length, 1);
  await writeFile(source, 'export class ControllerError extends Error { cause?: Error; }');
  await sentinel.request();
  assert.equal(posts.length, 2);
  assert.match(posts[1], /cleared/);
  assert.equal(requests, 4, 'a healthy pass fetches one bundle without retries');
  // Historical export map: ./* also selects package.json and resolves it to a
  // nonexistent source module. Exercise package resolution at the HTTP boundary.
  const protocol = fixture.path('node_modules/@happier-dev/protocol');
  await mkdir(protocol, { recursive: true });
  const packagePath = `${protocol}/package.json`;
  await writeFile(packagePath, JSON.stringify({ name: '@happier-dev/protocol', exports: { './*': './src/*.ts' } }));
  mode = 'exports';
  await sentinel.request();
  assert.equal(posts.length, 3, 'package export failure must break the web graph');
  await writeFile(packagePath, JSON.stringify({ name: '@happier-dev/protocol',
    exports: { './package.json': './package.json', './*': './src/*.ts' } }));
  await sentinel.request();
  assert.equal(posts.length, 4);
  assert.match(posts[3], /cleared/);
  const { loadWebBundle } = await import('./web-bundle.mjs');
  mode = 'malformed';
  assert.equal((await loadWebBundle({ repoDir: fixture.root, env })).loadError.code, 'expo_http_500');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadWebBundle({ repoDir: fixture.root, env, signal: controller.signal }));
  await writeFile(fixture.path('stacks/main/stack.runtime.json'), '{}');
  const unavailable = await loadWebBundle({ repoDir: fixture.root, env });
  assert.equal(unavailable.loadError.code, 'expo_unavailable');
  assert.equal(unavailable.status, 'unavailable');
  await sentinel.request();
  assert.equal(posts.length, 4, 'endpoint outage must not announce a source break');
});


test('web bundle follows checkout identity without a selected stack and preserves breaks across outages', async t => {
  const { fixture } = await fixtureGraph(t);
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { resolveRepoStackIdentity } = await import('../utils/stack/repo_stack_identity.mjs');
  const { formatLoadSentinelResult } = await import('./load-sentinel.mjs');
  const env = { HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  const identity = resolveRepoStackIdentity({ repoRoot: fixture.root, stacksStorageRoot: env.HAPPIER_STACK_STORAGE_DIR });
  await mkdir(identity.stackBaseDir, { recursive: true });
  const statePath = identity.runtimeStatePath;
  let mode = 'healthy';
  let bundles = 0;
  const server = createServer((req, res) => {
    if (req.url === '/status') return res.end('packager-status:running');
    if (req.url === '/') return res.end('<html></html>');
    if (mode === 'bundle-http') { res.writeHead(404); return res.end(); }
    bundles++;
    if (mode === 'broken') { res.writeHead(500); return res.end(JSON.stringify({type: 'TransformError', filename: fixture.path('packages/cli-common/controllerErrors.ts'), lineNumber: 2})); }
    res.end('/* healthy bundle */');
  });
  server.listen(0); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const state = JSON.stringify({expo: {port: server.address().port, webEnabled: true}});
  const posts = [], results = [];
  const sentinel = createLoadSentinel({repoDir: fixture.root, env, graphs: sentinelGraphs().filter(g => g.id === 'ui-web-bundle'),
    signal: t.signal, waitForQuiet: async () => {}, post: async p => posts.push(p), onResult: r => results.push(r)});
  await sentinel.request();
  assert.equal(results.at(-1).status, 'unavailable');
  assert.equal(formatLoadSentinelResult(results.at(-1)).code, 'expo_unavailable');
  assert.equal(posts.length, 0);
  await writeFile(statePath, state);
  await sentinel.request();
  assert.equal(results.at(-1).status, 'passed', 'a checkout with running Expo must resolve without stack env');
  assert.equal(bundles, 1, 'one bundle request per healthy pass');
  for (const [nextMode, code] of [['bundle-http', 'expo_http_404']]) {
    mode = nextMode; await sentinel.request();
    assert.equal(results.at(-1).status, 'unavailable');
    assert.equal(formatLoadSentinelResult(results.at(-1)).code, code);
    assert.equal(posts.length, 0, 'endpoint/configuration failure is not a source alert');
  }
  mode = 'broken'; await sentinel.request();
  assert.equal(results.at(-1).status, 'failed');
  assert.equal(formatLoadSentinelResult(results.at(-1)).code, 'expo_http_500');
  assert.equal(posts.length, 1); assert.match(posts[0], /URGENT/);
  await writeFile(statePath, '{}'); await sentinel.request();
  assert.equal(posts.length, 1, 'unavailability neither breaks nor clears source');
  await writeFile(statePath, state); await sentinel.request();
  assert.equal(posts.length, 1, 'the known source break remains deduplicated after an outage');
  mode = 'healthy'; await sentinel.request();
  assert.equal(posts.length, 2); assert.match(posts[1], /cleared/);
});


test('UI graph includes generated voice declarations in its strict boot-contract check', async t => {
  const { fixture } = await fixtureGraph(t);
  const graph = ENTRY_GRAPHS.find(graph => graph.id === 'ui-catalog');
  await mkdir(fixture.path('apps/ui/sources/agents/catalog'), { recursive: true });
  await mkdir(fixture.path('apps/ui/sources/voice/registry'), { recursive: true });
  await writeFile(fixture.path('apps/ui/vitest.config.ts'), 'export default {test:{environment:"node", globals:true}};');
  await writeFile(fixture.path(graph.entry), 'test("catalog", () => {});');
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../../ui/package.json', import.meta.url));
  const zod = require.resolve('zod');
  const voiceTest = fixture.path('apps/ui/sources/voice/registry/providerRegistry.test.ts');
  // Historical mismatch: the strict turn schema lost replay while generated
  // declarations still carried it. Real Zod parsing must reach the UI graph.
  await writeFile(voiceTest, `import { z } from ${JSON.stringify(zod)};
test('generated voice boot contract', () => {
  z.strictObject({ turn: z.strictObject({ cancelResponse: z.boolean() }) })
    .parse({ turn: { cancelResponse: false, replay: 'stable_ids' } });
});`);
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: t.signal,
    waitForQuiet: async () => {}, post: async value => posts.push(value) });
  await sentinel.request();
  assert.equal(posts.length, 1, 'a green catalog must not hide a generated voice schema failure');
  await writeFile(voiceTest, 'test("repaired projection", () => {});');
  await sentinel.request();
  assert.equal(posts.length, 2);
  assert.match(posts[1], /cleared/);
});


test('machine recipe, firewall and contributions cycle reaches the sentinel as a real TDZ', async t => {
  const { fixture, graph, entry } = await fixtureGraph(t);
  const root = fixture.path('packages/protocol/src');
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/machineRecipeV1.mjs`, "import { firewall } from './machineFirewallV1.mjs'; export const canonicalRecipeSchema = { firewall };");
  await writeFile(`${root}/machineFirewallV1.mjs`, "import { contributions } from './contributions.mjs'; export const firewall = { contributions };");
  await writeFile(`${root}/contributions.mjs`, "import { canonicalRecipeSchema } from './machineRecipeV1.mjs'; export const contributions = { recipe: canonicalRecipeSchema };");
  await writeFile(entry, "import '../../../packages/protocol/src/machineRecipeV1.mjs';");
  const posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [{ ...graph, args: [] }], signal: t.signal,
    waitForQuiet: async () => {}, post: async value => posts.push(value) });
  await sentinel.request();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /symbol=canonicalRecipeSchema/);
  assert.match(posts[0], /contributions.mjs/);
  await writeFile(`${root}/contributions.mjs`, 'export const contributions = {};');
  await sentinel.request();
  assert.equal(posts.length, 2);
  assert.match(posts[1], /cleared/);
});
