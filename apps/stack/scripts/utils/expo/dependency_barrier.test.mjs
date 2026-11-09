import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { ensureDevExpoServer, inspectExpoMetroConfigState } from '../dev/expo_dev.mjs';
import { readDependencyPublicationState, withDependencyRefresh, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { getExpoStatePaths, isStateProcessRunning, writePidState } from './expo.mjs';
import { expoExec, expoSpawn } from './command.mjs';

async function waitFor(predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'scratch consumer did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixtureFor(t, { uiPostinstall = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-metro-', parentDir: tmpdir() });
  const { uiDir } = await ensureMinimalMonorepoLayout(fixture.root);
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/app',
    ...(uiPostinstall ? { scripts: { 'postinstall:real': 'node tools/postinstall.mjs' } } : {}) }));
  await writeFile(fixture.path('package.json'), '{"private":true,"workspaces":["apps/*"]}\n');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  await mkdir(fixture.path('node_modules', '.bin'), { recursive: true });
  const patchOutput = fixture.path('node_modules/react-native-enriched-markdown/lib/module/web/streamingReveal.js');
  if (uiPostinstall) {
    await mkdir(join(patchOutput, '..'), { recursive: true });
    await writeFile(patchOutput, 'export {};');
  }
  const pnpmEntrypoint = fixture.path('pnpm.cjs');
  await writeFile(pnpmEntrypoint, "if (process.argv[2] === '--version') console.log('12.14.0'); else process.exit(43);\n");
  const stackName = 'scratch-metro';
  const baseDir = fixture.path('stacks', stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });
  await writeFile(envPath, `HAPPIER_STACK_REPO_DIR=${fixture.root}\n`);
  const env = {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
    npm_execpath: pnpmEntrypoint, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'), HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0',
    HAPPIER_STACK_EXPO_CLEAR_CACHE: '0', HAPPIER_STACK_EXPO_SUPERVISE_RESTARTS: '0',
  };
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  return { ...fixture, uiDir, env, baseDir, envPath, stackName, patchOutput };
}

async function writeExpo(fixture, source = "console.log('served');") {
  const executable = fixture.path('node_modules', '.bin', 'expo');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
  await chmod(executable, 0o755);
}

for (const watchEnabled of [false, true]) test(`dev keeps its serving Expo through workspace dependency publication (watch=${watchEnabled})`, { timeout: 60_000 }, async t => {
  // Owner ruling 2026-11-01, Un-gating dependency work (B): dependency
  // changes do not force dev-stack restarts. Run the actual dev composition.
  const fixture = await fixtureFor(t);
  const starts = fixture.path('expo-starts');
  await writeExpo(fixture, `
    require('node:fs').appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
    require('node:http').createServer((req, res) => res.end('packager-status:running'))
      .listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
  `);
  const runtimePath = fixture.path('runtime.json');
  const devLog = fsSync.openSync(fixture.path('dev.log'), 'w');
  t.after(() => fsSync.closeSync(devLog));
  const owner = spawn(process.execPath, [fileURLToPath(new URL('../../dev.mjs', import.meta.url)),
    '--no-server', '--no-daemon', '--no-browser', '--no-dev-targets',
    watchEnabled ? '--watch' : '--no-watch', '--bind=loopback', '--server-url=http://127.0.0.1:12345'], {
    cwd: fixture.root, detached: true, stdio: ['ignore', devLog, devLog], env: { ...fixture.env,
      HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_RUNTIME_STATE_PATH: runtimePath,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0', HAPPIER_STACK_CLI_BUILD: '0',
    },
  });
  t.after(async () => { await killProcessTree(owner, 'SIGTERM'); });
  let runtime;
  await waitFor(async () => {
    assert.equal(owner.exitCode ?? owner.signalCode, null, 'the scratch dev owner must stay running');
    runtime = JSON.parse(await readFile(runtimePath, 'utf8').catch(() => '{}'));
    return runtime?.processes?.expoPid && runtime?.expo?.port;
  }, { timeoutMs: 30_000 }).catch(async error => {
    const diagnostic = (await readFile(fixture.path('dev.log'), 'utf8')).split('\n')
      .filter(line => !/:\/\/|bearer |token|secret|password|api_?key|credential|database_url|-----begin|private_key/i.test(line))
      .slice(-30).join('\n');
    throw new Error(`${error.message}; runtime present=${Boolean(runtime)}; Expo PID=${runtime?.processes?.expoPid ?? 0}; Expo port=${runtime?.expo?.port ?? 0}\n${diagnostic}`, { cause: error });
  });
  const pid = runtime.processes.expoPid;
  const origin = `http://127.0.0.1:${runtime.expo.port}`;
  await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  const publication = await readDependencyPublicationState({ installDir: fixture.root, env: fixture.env });
  const manifest = JSON.parse(await readFile(join(fixture.uiDir, 'package.json'), 'utf8'));
  await writeFile(join(fixture.uiDir, 'package.json'), JSON.stringify({ ...manifest,
    dependencies: { '@happier-dev/scratch-plugin': 'workspace:*' } }));
  // This fixture's installer boundary publishes the changed workspace tree;
  // it never installs into the primary checkout or starts a shared Metro.
  await withDependencyRefresh({ installDir: fixture.root, env: fixture.env, force: true }, async () => {
    await writeFile(fixture.path('node_modules', 'workspace-plugin.mjs'), 'export const ready = true;');
  });
  assert.notEqual((await readDependencyPublicationState({ installDir: fixture.root, env: fixture.env })).completedGeneration,
    publication.completedGeneration, 'a real successful dependency publication must reach the dev owner');
  // Cover the existing 500 ms coordinator debounce and asynchronous replacement.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.equal(await readFile(starts, 'utf8'), `${pid}\n`, 'dependency changes must admit zero Expo replacements');
  assert.equal(await (await fetch(`${origin}/status`)).text(), 'packager-status:running');
});

for (const invocation of ['spawn', 'exec']) test(`Metro refreshes dependencies on demand and honors explicit suppression (${invocation})`, async t => {
  const fixture = await fixtureFor(t);
  const callsPath = fixture.path('installs');
  await writeFile(fixture.env.npm_execpath, [
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') console.log('12.14.0');",
    `else fs.appendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(' ') + '\\n');`,
  ].join('\n'));
  await writeExpo(fixture);
  const markerPath = fixture.path('node_modules', '.happier-stack-dependencies-ready');
  const before = await readFile(markerPath, 'utf8');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# new dependencies\n');
  const options = { dir: fixture.uiDir, projectDir: fixture.uiDir, args: ['start', '--web'],
    env: fixture.env, quiet: true, options: { silent: true } };
  const start = async env => {
    if (invocation === 'spawn') assert.equal((await (await expoSpawn({ ...options, env })).completion).code, 0);
    else await expoExec({ ...options, env });
  };
  await start({ ...fixture.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' });
  assert.equal(await readFile(markerPath, 'utf8'), before);
  await assert.rejects(readFile(callsPath), { code: 'ENOENT' });
  await start({ ...fixture.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0' });
  assert.match(await readFile(callsPath, 'utf8'), /install/);
  assert.notEqual(await readFile(markerPath, 'utf8'), before);
});

for (const invocation of ['spawn', 'exec']) test(`Metro startup waits only for an active installer (${invocation})`, async t => {
  const fixture = await fixtureFor(t);
  const started = fixture.path('started');
  await writeExpo(fixture, `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');`);
  let enter, release;
  const admitted = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const writer = withDependencyRefreshLock({ installDir: fixture.root, env: fixture.env }, async () => { enter(); await held; });
  let startup;
  t.after(async () => { release(); await writer; await startup; });
  await admitted;
  const options = { dir: fixture.uiDir, projectDir: fixture.uiDir, args: ['start', '--web'],
    env: fixture.env, quiet: true, options: { silent: true } };
  startup = invocation === 'exec' ? expoExec(options) : expoSpawn(options).then(async child => {
    assert.equal((await child.completion).code, 0);
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(readFile(started), { code: 'ENOENT' });
  release();
  await writer;
  await startup;
  assert.equal(await readFile(started, 'utf8'), 'started');
});

test('dependency refresh neither refuses nor stops a foreign legacy Metro or pending start', async t => {
  const fixture = await fixtureFor(t);
  const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32', stdio: 'ignore', env: fixture.env,
  });
  t.after(async () => await killProcessTree(child, 'SIGTERM', { graceMs: 500 }));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const baseDir = fixture.path('stacks', 'foreign');
  await mkdir(join(baseDir, 'source-runtime'), { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${fixture.root}\n`);
  await writeFile(join(baseDir, 'source-runtime/start.pending.json'), JSON.stringify({ pid: process.pid, phase: 'preparing' }));
  const paths = getExpoStatePaths({ baseDir, kind: 'expo-dev', projectDir: fixture.uiDir });
  await writePidState(paths.statePath, { pid: child.pid, projectDir: fixture.uiDir, uiDir: fixture.uiDir });
  await writeFile(fixture.path('pnpm-lock.yaml'), '# changed\n');
  let installed = false;
  const result = await withDependencyRefresh({ installDir: fixture.root, env: fixture.env }, async () => {
    installed = true;
    assert.equal(child.exitCode ?? child.signalCode, null);
  });
  assert.equal(installed, true);
  assert.ok(result.stacksNeedingRestart.includes('foreign'));
  assert.equal(child.exitCode ?? child.signalCode, null);
});

for (const cancel of [false, true]) test(`Metro preserves its incumbent while a replacement waits for an active installer (shutdown=${cancel})`, async t => {
  const fixture = await fixtureFor(t);
  const children = [];
  let shuttingDown = false, original, replacement, replacementStart, releaseWriter;
  const held = new Promise(resolve => { releaseWriter = resolve; });
  t.after(async () => {
    releaseWriter();
    await replacementStart?.catch(() => {});
    shuttingDown = true;
    await original?.close?.();
    await replacement?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
  });
  await writeExpo(fixture, "require('node:http').createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1');");
  const options = { startUi: true, uiDir: fixture.uiDir, autostart: { baseDir: fixture.baseDir },
    baseEnv: fixture.env, apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: fixture.stackName,
    runtimeStatePath: fixture.path('runtime.json'), envPath: fixture.envPath, children,
    isShuttingDown: () => shuttingDown, quiet: true, spawnOptions: { silent: true } };
  original = await ensureDevExpoServer(options);
  const origin = `http://127.0.0.1:${original.port}`;
  await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  let entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  const writer = withDependencyRefreshLock({ installDir: fixture.root, env: fixture.env }, async () => { entered(); await held; });
  await admitted;
  replacementStart = ensureDevExpoServer({ ...options, restart: true,
    baseEnv: { ...fixture.env, HAPPIER_STACK_EXPO_DEV_PORT: String(original.port), HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable' } });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(original.proc.exitCode ?? original.proc.signalCode, null);
  assert.equal((await fetch(`${origin}/status`)).status, 200);
  if (cancel) shuttingDown = true;
  releaseWriter();
  await writer;
  if (cancel) {
    await assert.rejects(replacementStart, { name: 'AbortError' });
    assert.equal((await fetch(`${origin}/status`)).status, 200);
  } else {
    replacement = await replacementStart;
    assert.notEqual(replacement.pid, original.pid);
    assert.equal(replacement.port, original.port);
    await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  }
});

test('Expo adoption replaces dependencies refreshed while its prior reload owner was absent', async t => {
  const fixture = await fixtureFor(t);
  const children = [];
  let initial, replacement, stopping = false;
  t.after(async () => {
    stopping = true;
    await initial?.close?.();
    await replacement?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
  });
  await writeExpo(fixture, `process.title = ${JSON.stringify(join(fixture.uiDir, 'expo'))};\nrequire('node:http').createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1');`);
  const options = { startUi: true, uiDir: fixture.uiDir, autostart: { baseDir: fixture.baseDir },
    baseEnv: fixture.env, apiServerUrl: 'http://127.0.0.1:1', stackMode: true,
    stackName: fixture.stackName, runtimeStatePath: fixture.path('runtime.json'), envPath: fixture.envPath,
    children, isShuttingDown: () => stopping, quiet: true, spawnOptions: { silent: true } };
  initial = await ensureDevExpoServer(options);
  await waitFor(async () => fetch(`http://127.0.0.1:${initial.port}/status`).then(response => response.ok).catch(() => false));
  const statePaths = getExpoStatePaths({ baseDir: fixture.baseDir, kind: 'expo-dev', projectDir: fixture.uiDir });
  const incumbent = await isStateProcessRunning(statePaths.statePath);
  assert.equal(incumbent.running, true, `fixture Expo must satisfy actual adoption admission (${incumbent.reason})`);
  await initial.close();
  const healthy = await ensureDevExpoServer(options);
  assert.equal(healthy.skipped, true);
  assert.equal(healthy.pid, initial.pid, 'unchanged dependencies must preserve the existing Expo');
  await assert.rejects(withDependencyRefresh({ installDir: fixture.root, env: fixture.env, force: true },
    async () => { throw new Error('failed off-owner refresh'); }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  const afterFailure = await isStateProcessRunning(statePaths.statePath);
  assert.equal(afterFailure.running, true);
  assert.equal(afterFailure.state.pid, initial.pid, 'failed refresh must keep the incumbent Expo');
  assert.equal((await inspectExpoMetroConfigState({ projectDir: fixture.uiDir,
    state: afterFailure.state, env: fixture.env })).current, true,
  'failed refresh must preserve the successful Metro input fingerprint');
  await withDependencyRefresh({ installDir: fixture.root, env: fixture.env, force: true }, async () => {});
  replacement = await ensureDevExpoServer(options);
  assert.equal(replacement.skipped, false, 'a successful off-owner refresh makes the recorded Metro inputs stale');
  assert.notEqual(replacement.pid, initial.pid);
  assert.notEqual(initial.proc.exitCode ?? initial.proc.signalCode, null);
});
