import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureDevExpoServer, resolveExpoMetroCacheRoot } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { retainBundledPluginUiArtifactsInventory } from '../../../../ui/scripts/generateBundledPluginUiArtifacts.mjs';

test('disposable supervised Metro keeps serving healthy bundles across a broken mid-edit import', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-live-reliability-', registerCleanup: false });
  const uiDir = fixture.path('repo/apps/ui');
  const children = [];
  let result;
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
    await Promise.all(children.map(child => child.completion));
    await fixture.cleanup();
  });
  const realUiDir = fileURLToPath(new URL('../../../../ui/', import.meta.url));
  const requireFromUi = createRequire(join(realUiDir, 'package.json'));
  const metroPath = join(dirname(requireFromUi.resolve('metro/package.json')), 'src/Server.js');
  const configPath = requireFromUi.resolve('metro-config');
  const cachePath = requireFromUi.resolve('metro-cache');
  const runtimeRoot = dirname(requireFromUi.resolve('metro-runtime/package.json'));
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"disposable-expo-reliability"}');
  await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = {};');
  await mkdir(join(uiDir, 'scripts'));
  await symlink(join(realUiDir, 'scripts/ensureWorkspacePackagesBuilt.mjs'), join(uiDir, 'scripts/ensureWorkspacePackagesBuilt.mjs'));
  const inventoryDir = join(uiDir, 'sources/sync/domains/plugins/availability');
  await mkdir(inventoryDir, { recursive: true });
  const inventory = join(inventoryDir, 'generatedBundledPluginUiArtifacts.js');
  const lastGreen = 'const BUNDLED_PLUGIN_UI_APP_ASSET_0 = require("./fixture.js");\nexport const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {fixture: BUNDLED_PLUGIN_UI_APP_ASSET_0};';
  await writeFile(inventory, lastGreen);
  await writeFile(join(inventoryDir, 'fixture.js'), 'module.exports = "LAST_GREEN_PLUGIN_UI";');
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const brokenPath = join(uiDir, 'broken.js');
  await writeFile(join(uiDir, 'healthy.js'), 'module.exports = require("./sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts");\n');
  await writeFile(brokenPath, 'module.exports = "BEFORE_EDIT";\n');
  const executable = join(uiDir, 'node_modules/.bin/expo');
  // Disposable Stack's executable starts real Metro, with no shared cache,
  // dependency mutation, app export, server, database, daemon or auth setup.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(${JSON.stringify(fixture.path('inventory-path'))}, process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY);
fs.writeFileSync(${JSON.stringify(fixture.path('cache-env'))}, JSON.stringify({root: process.env.HAPPIER_UI_METRO_CACHE_ROOT, identity: process.env.HAPPIER_UI_METRO_CACHE_IDENTITY}));
fs.writeFileSync('healthy.js', 'module.exports = require(' + JSON.stringify(process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY) + ');\\n');
const Metro = require(${JSON.stringify(metroPath)}).default;
let metro;
let listener;
(async () => {
  const config = await require(${JSON.stringify(configPath)}).getDefaultConfig(process.cwd());
  config.watchFolders = [process.cwd(), ${JSON.stringify(runtimeRoot)}, require('node:path').dirname(process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY)];
  config.maxWorkers = 1;
  config.resolver.useWatchman = false;
  config.resolver.nodeModulesPaths = ${JSON.stringify([join(realUiDir, 'node_modules'), join(realUiDir, '../../node_modules')])};
  const actualMetroConfig = require(${JSON.stringify(join(realUiDir, 'metro.config.js'))});
  config.cacheStores = typeof actualMetroConfig.cacheStores === 'function'
    ? actualMetroConfig.cacheStores({FileStore: require(${JSON.stringify(cachePath)}).FileStore}) : actualMetroConfig.cacheStores;
  config.cacheVersion = actualMetroConfig.cacheVersion;
  config.fileMapCacheDirectory = ${JSON.stringify(fixture.path('filemap'))};
  fs.mkdirSync(config.fileMapCacheDirectory);
  config.reporter = {update() {}};
  metro = new Metro(config, {watch: true});
  await metro.ready();
  listener = http.createServer((req, res) => {
    if (req.url === '/status') return res.end('packager-status:running');
    metro.processRequest(req, res, () => {res.statusCode = 404; res.end();});
  });
  listener.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
})();
process.on('SIGTERM', async () => { listener?.close(); await metro?.end(); process.exit(0); });
`);
  await chmod(executable, 0o755);
  const paths = getExpoStatePaths({ baseDir: fixture.root, kind: 'expo-dev', projectDir: uiDir });
  const retiredGraph = join(paths.stateDir, 'plugin-ui', 'preparation-ABC123');
  await mkdir(retiredGraph, { recursive: true });
  await writeFile(join(retiredGraph, 'old.chunk.bundle'), 'retired graph');
  const historical = new Date(Date.now() - 48 * 3600000);
  await utimes(join(retiredGraph, 'old.chunk.bundle'), historical, historical);
  await utimes(retiredGraph, historical, historical);
  const previous = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(previous, 'close');
  await writePidState(paths.statePath, { pid: previous.pid, port: 0 });
  // Control only the parent's OS process census. Real Stack startup, the UI
  // inventory owner, retention policy, spawned Metro and asset requests run.
  const readDirectories = fs.readdirSync;
  const processCensus = t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc' ? [] : readDirectories(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { processCensus.mock.restore(); syncBuiltinESMExports(); });
  result = await ensureDevExpoServer({ startUi: true, uiDir,
    autostart: { baseDir: fixture.root }, baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      HAPPIER_STACK_STACK: 'qa-dev-expo-reliability', HAPPIER_STACK_ENV_FILE: fixture.path('env'),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_EXPO_HOST: 'localhost',
      HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS: '25' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true,
    stackName: 'qa-dev-expo-reliability', envPath: fixture.path('env'), runtimeStatePath: fixture.path('runtime.json'),
    children, isShuttingDown: () => shuttingDown, quiet: true, spawnOptions: { silent: true } });
  processCensus.mock.restore();
  syncBuiltinESMExports();
  await assert.rejects(stat(retiredGraph), { code: 'ENOENT' }, 'actual Expo startup reclaims its retired plugin preparation');
  const origin = `http://127.0.0.1:${result.port}`;
  const readyDeadline = Date.now() + 15000;
  while (true) {
    if (await fetch(`${origin}/status`).then(r => r.ok).catch(() => false)) break;
    assert.ok(Date.now() < readyDeadline, 'own disposable Metro startup did not complete');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const cacheEnv = JSON.parse(await readFile(fixture.path('cache-env'), 'utf8'));
  const servingState = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal(cacheEnv.root, resolveExpoMetroCacheRoot({ tmpDir: paths.tmpDir,
    currentFingerprint: servingState.metroConfigFingerprint }), 'Stack binds the actual Metro consumer to its selected cache generation');
  assert.equal(cacheEnv.identity, servingState.metroConfigFingerprint);
  const bundle = entry => fetch(`${origin}/${entry}.bundle?platform=web&dev=true&minify=false`);
  const before = await bundle('broken');
  assert.equal(before.status, 200, await before.text());
  await writeFile(brokenPath, 'require("./missing-mid-edit-package");\n');
  const editDeadline = Date.now() + 15000;
  let broken;
  while (true) {
    broken = await bundle('broken');
    if (broken.status === 500) break;
    await broken.text();
    assert.ok(Date.now() < editDeadline, 'Metro did not observe the scratch source edit');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal((await broken.json()).type, 'UnableToResolveError');
  const healthy = await bundle('healthy');
  const healthyBytes = await healthy.text();
  assert.equal(healthy.status, 200, healthyBytes);
  assert.match(healthyBytes, /LAST_GREEN_PLUGIN_UI/);
  assert.equal(await readFile(inventory, 'utf8'), lastGreen);
  assert.match(warnings.join('\n'), /background refresh failed; retained last-green output/,
    'real UI preparation fails its missing patched dependency while Metro serves retained plugin UI');
  const consumedInventory = await readFile(fixture.path('inventory-path'), 'utf8');
  assert.notEqual(consumedInventory, inventory);
  await writeFile(join(inventoryDir, 'next.js'), 'module.exports = "NEXT_GREEN_PLUGIN_UI";');
  await writeFile(inventory, 'const BUNDLED_PLUGIN_UI_APP_ASSET_0 = require("./next.js");\nexport const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {fixture: BUNDLED_PLUGIN_UI_APP_ASSET_0};');
  const beforePublication = await bundle('healthy');
  assert.match(await beforePublication.text(), /LAST_GREEN_PLUGIN_UI/);
  await retainBundledPluginUiArtifactsInventory({ inventoryPath: inventory, outputPath: consumedInventory });
  const refreshDeadline = Date.now() + 15000;
  for (;;) {
    const updated = await bundle('healthy');
    if ((await updated.text()).includes('NEXT_GREEN_PLUGIN_UI')) break;
    assert.ok(Date.now() < refreshDeadline, 'Metro did not consume the next green inventory publication');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal((await fetch(`${origin}/status`)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(children.length, 1, 'bundle failures must not recycle the Metro process');
  assert.equal(result.proc.exitCode, null);
});

test('disposable supervisor recycles a real near-limit isolate only after its bundle completes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-live-heap-', registerCleanup: false });
  const uiDir = fixture.path('ui');
  const children = [];
  let result;
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
    await Promise.all(children.map(child => child.completion));
    await fixture.cleanup();
  });
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"heap-fixture"}');
  const allocatedPath = fixture.path('allocated');
  const runsPath = fixture.path('runs');
  const executable = join(uiDir, 'node_modules/.bin/expo');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const v8 = require('node:v8');
const runPath = ${JSON.stringify(runsPath)};
const count = Number(fs.existsSync(runPath) ? fs.readFileSync(runPath, 'utf8') : 0) + 1;
fs.writeFileSync(runPath, String(count));
const retained = [];
require('node:http').createServer((req, res) => {
  if (req.url === '/hold.bundle' && count === 1) {
    while (v8.getHeapStatistics().used_heap_size < 64 * 1024 * 1024 * .92) retained.push(new Array(131072).fill(count));
    fs.writeFileSync(${JSON.stringify(allocatedPath)}, 'allocated');
    return setTimeout(() => res.end('BUNDLE_FINISHED'), 400);
  }
  res.end('packager-status:running');
}).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
  await chmod(executable, 0o755);
  result = await ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: fixture.root },
    baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      HAPPIER_STACK_STACK: 'qa-dev-expo-quiet-heap', HAPPIER_STACK_ENV_FILE: fixture.path('env'),
      // This fixture owns a synthetic installed Expo bin, not a Yarn install.
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB: '64',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'qa-dev-expo-quiet-heap',
    envPath: fixture.path('env'), runtimeStatePath: fixture.path('runtime.json'), children,
    isShuttingDown: () => shuttingDown, quiet: false, spawnOptions: { silent: true } });
  const origin = `http://127.0.0.1:${result.port}`;
  const waitFor = async check => {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, 'own disposable heap supervisor did not reach its expected state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  const bundle = fetch(`${origin}/hold.bundle`).then(r => r.text());
  await waitFor(async () => (await readFile(allocatedPath, 'utf8').catch(() => '')) === 'allocated');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(children.length, 1, 'heap pressure must not interrupt the active bundle');
  assert.equal(children[0].exitCode, null);
  assert.equal(await bundle, 'BUNDLE_FINISHED');
  await waitFor(async () => children.length === 2 && Number(await readFile(runsPath, 'utf8')) === 2);
  await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  assert.equal(children[1].exitCode, null);
});
