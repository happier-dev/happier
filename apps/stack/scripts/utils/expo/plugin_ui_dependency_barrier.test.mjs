import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { captureSourceWebBuildInputs } from '../../build/build_source_runtime.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { resolveDependencyRefreshLockPath } from '../proc/dependency_refresh.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';

async function inventoryFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-plugin-ui-install-race-', registerCleanup: false });
  const repoRoot = fixture.path('repo');
  const sourceRepo = fileURLToPath(new URL('../../../../../', import.meta.url));
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoRoot });
  // Match the existing composed source-UI harness: captured workspaces resolve
  // their authored exports and keep real process-admission tooling available.
  await import(pathToFileURL(join(sourceRepo, 'packages/cli-common/registerSourceRuntime.mjs')));
  await promises.cp(join(sourceRepo, 'apps/ui/tools'), join(repoRoot, 'apps/ui/tools'), { recursive: true });
  await promises.cp(join(sourceRepo, 'apps/stack/bin'), join(repoRoot, 'apps/stack/bin'), { recursive: true });
  const uiPackageDir = join(repoRoot, 'apps/ui');
  const manifestPath = join(repoRoot, 'apps/cli/package.json');
  const manifest = JSON.parse(await promises.readFile(manifestPath, 'utf8'));
  await promises.writeFile(manifestPath, JSON.stringify({ ...manifest, bundledDependencies: [] }));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: fixture.path('consumer/inventory.js'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs')).href}`].filter(Boolean).join(' ') };
  const module = await import(pathToFileURL(join(uiPackageDir, 'scripts/ensureWorkspacePackagesBuilt.mjs')));
  const lockPath = resolveDependencyRefreshLockPath(repoRoot, env);
  assert.equal((await promises.lstat(join(repoRoot, 'node_modules'))).isDirectory(), true,
    'the captured installation must own its modules container, not alias the shared installation');
  const gateRelativeToFixture = relative(fixture.root, lockPath);
  assert.ok(gateRelativeToFixture && gateRelativeToFixture !== '..' && !gateRelativeToFixture.startsWith(`..${sep}`)
    && !isAbsolute(gateRelativeToFixture), 'the Plugin UI install fixture must never acquire the shared checkout dependency gate');
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const admitted = new Promise(resolve => { entered = resolve; });
  // Hold the installer's actual OS lock for this owned installation. External
  // package links supply tools, but no install or shared dependency write runs.
  const writer = withJsonOwnerFileLock(async () => { entered(); await held; },
    { lockPath, timeoutMs: Infinity });
  t.after(async () => { release(); await writer; });
  await admitted;
  let waits = 0, preparations = 0, inputReads = 0;
  const nativeWatch = fs.watch;
  const nativeMkdtemp = promises.mkdtemp;
  const nativeReadFile = promises.readFile;
  // Observe genuine filesystem boundaries, leaving the input census, source
  // compiler, publication, and dependency lock implementation real.
  t.mock.method(fs, 'watch', (path, ...args) => {
    if (String(path) === dirname(lockPath)) waits++;
    return nativeWatch(path, ...args);
  });
  t.mock.method(promises, 'mkdtemp', (path, ...args) => {
    if (String(path).includes('.happier-plugin-ui-stage-')) preparations++;
    return nativeMkdtemp(path, ...args);
  });
  t.mock.method(promises, 'readFile', (path, ...args) => {
    if (String(path) === manifestPath) inputReads++;
    return nativeReadFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { fixture, repoRoot, uiPackageDir, env, module, release, writer,
    counts: () => ({ waits, preparations, inputReads }) };
}

test('Plugin UI dependency-change refresh waits for install release and coalesces held arrivals', async t => {
  const state = await inventoryFixture(t);
  const events = new EventEmitter();
  const graph = new EventEmitter();
  graph.doesFileExist = path => fs.existsSync(path);
  // Metro is an external SDK boundary; all Happier inventory logic remains real.
  const bundler = { getWatcher: () => events, getDependencyGraph: async () => graph };
  const metroServer = { getBundler: () => ({ getBundler: () => bundler }),
    getWatchFolders: () => [state.fixture.path('consumer')] };
  const metroConfig = { projectRoot: state.uiPackageDir,
    resolver: { sourceExts: ['js'], assetExts: ['bundle', 'map'] }, watcher: { additionalExts: [] } };
  const failures = [];
  const owner = state.module.watchUiSourcePluginInventory({ ...state, metroServer, metroConfig,
    logger: { error: (...args) => failures.push(args) } });
  t.after(async () => { state.release(); await state.writer; await owner.close(); await state.fixture.cleanup(); });
  for (let arrival = 0; arrival < 20; arrival++) {
    events.emit('change', { eventsQueue: [{ filePath: join(state.uiPackageDir, 'package.json') }] });
  }
  await t.waitFor(() => assert.ok(state.counts().waits || state.counts().inputReads || failures.length));
  assert.equal(state.counts().inputReads, 0, 'no inventory input census may read during the active install');
  assert.equal(state.counts().preparations, 0, 'no inventory compiler may start during the active install');
  assert.deepEqual(failures, []);
  state.release();
  await state.writer;
  await t.waitFor(() => assert.ok(failures.length || fs.existsSync(state.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY)),
    { timeout: 120_000, interval: 50 });
  await owner.close();
  assert.ok((await promises.readFile(state.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY)).length);
  assert.equal(state.counts().preparations, 1, 'held source arrivals must produce exactly one completed refresh');
  assert.deepEqual(failures, []);
});

for (const outcome of ['success', 'cancel', 'missing-module']) {
  test(`direct Plugin UI preparation respects an active install (${outcome})`, async t => {
    const state = await inventoryFixture(t);
    if (outcome === 'missing-module') {
      await promises.writeFile(join(state.uiPackageDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'),
        'import "missing-plugin-ui-dependency-after-install";\n');
    }
    const cancellation = new AbortController();
    const preparation = state.module.prepareUiSourcePluginInventory({ ...state, signal: cancellation.signal });
    // Attach immediately so the old implementation's early failure is recorded.
    let observed;
    const settled = preparation.then(value => ({ value }), error => ({ error })).then(result => { observed = result; return result; });
    t.after(async () => { state.release(); await settled; await state.fixture.cleanup(); });
    await t.waitFor(() => assert.ok(state.counts().waits || state.counts().preparations || observed));
    if (observed?.error) throw observed.error;
    assert.equal(state.counts().preparations, 0, 'preparation must not import/compiler-read the mixed dependency tree');
    if (outcome === 'cancel') cancellation.abort();
    else { state.release(); await state.writer; }
    const result = await settled;
    if (outcome === 'cancel') {
      assert.equal(result.error?.name, 'AbortError');
      assert.equal(state.counts().preparations, 0);
    } else if (outcome === 'missing-module') {
      assert.ok(result.error, 'real missing modules must still fail after install completion');
      assert.match(result.error.message, /missing-plugin-ui-dependency-after-install/);
    } else {
      assert.equal(result.error, undefined);
      assert.equal(result.value.ok, true);
      assert.equal(state.counts().preparations, 1);
    }
  });
}
