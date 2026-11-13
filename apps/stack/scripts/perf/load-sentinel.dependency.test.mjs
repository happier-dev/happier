// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'node:http';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../packages/cli-common/fileChangeObserver.mjs';
import { isJsonOwnerFileLockActive } from '../utils/proc/jsonOwnerFileLock.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { resolveDependencyRefreshLockPath, withDependencyRefreshLock } from '../utils/proc/dependency_refresh.mjs';
import { createLoadSentinel } from './load-sentinel.mjs';

test('dependency writer can publish between graphs while a sentinel cycle remains alive', async t => {
  const fixture = await createTempFixture(t, { prefix: 'sentinel-dependency-scope-' });
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};');
  await writeFile(fixture.path('graph.mjs'), 'export {};');
  const graph = { id: 'fixture-import', entry: 'graph.mjs', cwd: '.', args: [] };
  const between = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const results = [];
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_BUILD_DEPENDENCY_CUSTODY: '' };
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph, graph],
    env, signal: t.signal, post: async () => assert.fail('healthy graphs must not post'),
    onResult: async result => {
      results.push(result.status);
      if (results.length === 1) { between.resolve(); await resume.promise; }
    } });
  const cycle = sentinel.request();
  try {
    await between.promise;
    await withDependencyRefreshLock({ installDir: fixture.root, env, signal: t.signal, wait: false },
      async () => { await writeFile(fixture.path('publication-completed'), 'published'); });
  } finally {
    resume.resolve();
    await cycle;
  }
  assert.deepEqual(results, ['passed', 'passed']);
});


test('server graph nested consumption inherits custody while a dependency writer drains its parent', async t => {
  const fixture = await createTempFixture(t, { prefix: 'sentinel-nested-dependency-' });
  for (const directory of ['packages/cli-common', 'apps/server/sources/flavors/light',
    'apps/server/sources/flavors/full', 'node_modules']) {
    await mkdir(fixture.path(directory), { recursive: true });
  }
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};');
  await writeFile(fixture.path('apps/server/sources/configureZodLocale.ts'), 'export {};');
  await writeFile(fixture.path('apps/server/sources/flavors/full/main.ts'), 'export {};');
  const env = { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_BUILD_DEPENDENCY_CUSTODY: '' };
  const lockPath = resolveDependencyRefreshLockPath(fixture.root, env);
  const { dirname } = await import('node:path');
  await mkdir(dirname(lockPath), { recursive: true });
  let writer, published = false;
  const server = createServer((_request, response) => {
    (async () => {
      if (!writer) {
        const observer = createFileChangeObserver([dirname(lockPath)]);
        try {
          writer = withDependencyRefreshLock({ installDir: fixture.root, env, signal: t.signal },
            async () => { published = true; });
          // The real writer must own the gate before the nested read begins.
          const readGate = () => isJsonOwnerFileLockActive(lockPath);
          for (;;) {
            const snapshot = observer.capture(readGate);
            if (snapshot) break;
            await observer.wait({ snapshot, readSnapshot: readGate,
              maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal: t.signal });
          }
          assert.equal(published, false, 'writer must still be draining the active graph');
        } finally { observer.close(); }
      }
      response.end();
    })().catch(error => { response.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const owner = new URL('../utils/proc/dependency_refresh.mjs', import.meta.url).href;
  await writeFile(fixture.path('apps/server/sources/flavors/light/main.ts'), `
    import { withDependencyConsumption } from ${JSON.stringify(owner)};
    export async function runLightServerMain() {
      await fetch(${JSON.stringify('http://127.0.0.1:')} + ${JSON.stringify(address.port)});
      await withDependencyConsumption({ installDir: ${JSON.stringify(fixture.root)}, wait: false }, async () => {});
    }
  `);
  const results = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, env, signal: t.signal,
    graphs: [{ id: 'server', entry: 'apps/server/sources/flavors/light/main.ts', cwd: 'apps/server' }],
    post: async () => {}, waitForQuiet: async () => {},
    onResult: async result => { results.push(result.status); await writer; },
  });
  await sentinel.request();
  assert.deepEqual(results, ['passed']);
  assert.equal(published, true, 'writer publishes after the graph releases custody');
});
