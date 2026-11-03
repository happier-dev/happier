import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { loadEntryGraph } from './entry-load.mjs';
import { withDependencyRefresh } from '../utils/proc/dependency_refresh.mjs';

test('each entry graph waits for an in-progress installation before loading installed modules', async t => {
  const fixture = await createTempFixture(t, { prefix: 'entry-graph-install-wait-' });
  await mkdir(fixture.path('packages/sdk/scripts'), { recursive: true });
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};\n');
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), waiting = Promise.withResolvers();
  const originalWrite = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', function (chunk, ...args) {
    if (String(chunk).includes('waiting for dependency refresh lock')) waiting.resolve();
    return originalWrite(chunk, ...args);
  });
  // Only the installer publishes the module the graph is about to import.
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const writer = withDependencyRefresh({ installDir: fixture.root, env, force: true, signal: t.signal }, async () => {
    entered.resolve(); await release.promise;
    await mkdir(fixture.path('node_modules'), { recursive: true });
    await writeFile(fixture.path('packages/sdk/scripts/validateBrowserConsumer.mjs'),
      'export async function validateBrowserConsumer() {}\n');
  });
  await entered.promise;
  const graph = { id: 'sdk-browser', entry: 'packages/sdk/scripts/validateBrowserConsumer.mjs', cwd: 'packages/sdk' };
  const loading = loadEntryGraph(graph, { repoDir: fixture.root, env, signal: t.signal });
  try {
    await Promise.race([waiting.promise, loading.then(() => {
      assert.fail('entry graph loaded while the installation was still rewriting dependencies');
    })]);
  } finally { release.resolve(); await writer; }
  assert.equal((await loading).status, 'passed');
});

test('an installation waits until an admitted entry graph finishes its imports', async t => {
  const fixture = await createTempFixture(t, { prefix: 'entry-graph-reader-' });
  await mkdir(fixture.path('packages/sdk/scripts'), { recursive: true });
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};\n');
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  await writeFile(fixture.path('packages/sdk/scripts/validateBrowserConsumer.mjs'), `
    import { watch } from 'node:fs';
    import { writeFile } from 'node:fs/promises';
    export async function validateBrowserConsumer() {
      const released = new Promise(resolve => {
        const watcher = watch(new URL('../../../', import.meta.url), (_event, name) => {
          if (name === 'release-graph') { watcher.close(); resolve(); }
        });
      });
      await writeFile(new URL('../../../graph-started', import.meta.url), 'started');
      await released;
    }
  `);
  const entered = Promise.withResolvers(), waiting = Promise.withResolvers();
  const watcher = watch(fixture.root, (_event, name) => {
    if (name === 'graph-started') entered.resolve();
  });
  t.after(() => watcher.close());
  const originalWrite = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', function (chunk, ...args) {
    if (String(chunk).includes('waiting for dependency consumers lock')) waiting.resolve();
    return originalWrite(chunk, ...args);
  });
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const loading = loadEntryGraph({ id: 'sdk-browser', entry: 'packages/sdk/scripts/validateBrowserConsumer.mjs',
    cwd: 'packages/sdk' }, { repoDir: fixture.root, env, signal: t.signal });
  let writer;
  try {
    await Promise.race([entered.promise, loading.then(result => {
      assert.fail(`entry graph finished before the import boundary: ${result.status}`);
    })]);
    writer = withDependencyRefresh({ installDir: fixture.root, env, force: true, signal: t.signal }, async () => {});
    await Promise.race([waiting.promise, writer.then(() => {
      assert.fail('installation rewrote dependencies before the entry graph finished importing');
    })]);
  } finally {
    await writeFile(fixture.path('release-graph'), 'release');
    await writer;
  }
  assert.equal((await loading).status, 'passed');
});
