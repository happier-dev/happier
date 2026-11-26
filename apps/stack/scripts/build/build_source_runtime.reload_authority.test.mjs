// @happier-test-preparation source
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { admitSourceRuntimeReload } from './build_source_runtime.mjs';
import { readSourceReloadRefusal } from '../runtime/shared/source_reload_refusal.mjs';

const smokeRelativePath = 'apps/stack/scripts/runtime/launch/smokeSourceRuntimeReload.mjs';

async function writeSource(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

test('pinned reload smoke uses selected script, preloads and cwd despite a syntax-broken mirror workspace', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reload-authority-' });
  const mirror = fixture.path('mirror');
  const selected = fixture.path('selected');
  const result = fixture.path('smoke.json');
  for (const root of [mirror, selected]) {
    await writeSource(root, 'packages/protocol/workspace.mjs', root === mirror ? 'export const broken = ;' : 'export const ready = true;');
    await writeSource(root, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs',
      `import { ready } from '../../../packages/protocol/workspace.mjs'; globalThis.bootstrapReady = ready;`);
    await writeSource(root, 'packages/cli-common/registerSourceRuntime.mjs',
      `import { ready } from '../protocol/workspace.mjs'; globalThis.sourceReady = ready;`);
    await writeSource(root, smokeRelativePath, `
      import assert from 'node:assert/strict';
      import { writeFile } from 'node:fs/promises';
      assert.equal(globalThis.bootstrapReady, true);
      assert.equal(globalThis.sourceReady, true);
      await writeFile(${JSON.stringify(result)}, JSON.stringify({ script: import.meta.url, cwd: process.cwd(), payload: JSON.parse(process.argv[2]) }));
    `);
  }
  const server = { sourceTree: { dir: selected } };
  const admitted = await admitSourceRuntimeReload({ stackBaseDir: fixture.path('stack'), components: { server },
    pending: { signal: t.signal }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: mirror } });
  assert.equal(typeof admitted.activate, 'function');
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), {
    script: pathToFileURL(join(selected, smokeRelativePath)).href, cwd: selected, payload: { components: { server } },
  });
});

test('pinned reload missing its selected smoke refuses with a typed cause and never spawns live tooling', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reload-missing-smoke-' });
  const selected = fixture.path('old-cut');
  await mkdir(selected);
  // Process launch is the boundary: no child, especially a live fallback, may run.
  t.mock.method(childProcess, 'spawn', () => { assert.fail('missing selected smoke must refuse before spawning'); });
  t.mock.method(childProcess, 'fork', () => { assert.fail('missing selected smoke must refuse before forking'); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(admitSourceRuntimeReload({ stackBaseDir: fixture.path('stack'),
      components: { server: { sourceTree: { dir: selected } } }, pending: { signal: t.signal },
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: fixture.path('mirror') } }), error => {
      assert.deepEqual(readSourceReloadRefusal(error), { component: 'server', entryGraph: 'server',
        phase: 'replacement-smoke', code: 'source_bundle_unavailable', reason: 'source_tree_smoke_missing', retryable: false });
      return true;
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('unpinned and bundle reload smoke retain the live script, preloads and cwd', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reload-live-smoke-' });
  const mirror = fixture.path('mirror');
  const bootstrap = 'apps/stack/bin/localSourceRuntimeBootstrap.mjs';
  const registration = 'packages/cli-common/registerSourceRuntime.mjs';
  await writeSource(mirror, bootstrap, 'export {};');
  await writeSource(mirror, registration, 'export {};');
  const spawn = childProcess.spawn;
  const fork = childProcess.fork;
  // Inspect the actual process boundary without launching a server or database.
  const launches = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    launches.push({ command, args, cwd: options.cwd });
    return spawn(process.execPath, ['-e', ''], options);
  });
  t.mock.method(childProcess, 'fork', (modulePath, args, options) => {
    const invocation = JSON.parse(args[1]);
    launches.push({ command: invocation.command, args: invocation.args, cwd: options.cwd });
    return fork(modulePath, [args[0], JSON.stringify({ ...invocation, command: process.execPath, args: ['-e', ''] })], options);
  });
  syncBuiltinESMExports();
  try {
    for (const server of [{}, { runtimeDir: fixture.path('bundle/apps/server'), entrypoint: fixture.path('bundle/main.mjs') }]) {
      await admitSourceRuntimeReload({ stackBaseDir: fixture.path('stack'), components: { server },
        pending: { signal: t.signal }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: mirror } });
      assert.deepEqual(launches.at(-1), { command: process.execPath, cwd: mirror, args: [
        '--conditions=happier-source', `--import=${pathToFileURL(join(mirror, bootstrap)).href}`,
        `--import=${pathToFileURL(join(mirror, registration)).href}`,
        fileURLToPath(new URL('../runtime/launch/smokeSourceRuntimeReload.mjs', import.meta.url)), JSON.stringify({ components: { server } }),
      ] });
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
