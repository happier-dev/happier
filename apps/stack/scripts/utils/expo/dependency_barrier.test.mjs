import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { ensureDevExpoServer } from '../dev/expo_dev.mjs';
import { withDependencyRefresh, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { ensureDepsInstalled } from '../proc/pm.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { killProcessTree, run } from '../proc/proc.mjs';
import { getExpoStatePaths, writePidState } from './expo.mjs';
import { expoExec, expoSpawn } from './command.mjs';

for (const invocation of ['spawn', 'exec']) test(`development Metro automatically refreshes stale installed dependencies (${invocation})`, async t => {
  const fixture = await fixtureFor(t);
  delete fixture.env.HAPPIER_STACK_SKIP_REFRESH_DEPS;
  const callsPath = fixture.path('installs');
  await writeFile(fixture.env.npm_execpath, [
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') console.log('12.14.0');",
    `else fs.appendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(' ') + '\\n');`,
  ].join('\n'));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# new dependencies\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const expoPath = fixture.path('node_modules', '.bin', 'expo');
  await writeFile(expoPath, `#!${process.execPath}\nconsole.log('served');\n`);
  await chmod(expoPath, 0o755);
  const options = { dir: fixture.uiDir, projectDir: fixture.uiDir,
    args: ['start', '--web'], env: fixture.env, quiet: true, options: { silent: true } };
  if (invocation === 'spawn') {
    const child = await expoSpawn(options);
    assert.equal((await child.completion).code, 0);
  } else await expoExec(options);
  assert.match(await readFile(callsPath, 'utf8').catch(() => ''), /install/,
    'development startup must refresh stale dependencies through the package manager');
});

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'scratch consumer did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixtureFor(t, { baseEnv = process.env } = {}) {
  const fixture = await createTempFixture(t, {
    prefix: 'happier-dependency-metro-',
    parentDir: tmpdir(),
  });
  const { uiDir } = await ensureMinimalMonorepoLayout(fixture.root);
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
  }));
  await writeFile(fixture.path('package.json'), '{"private":true,"workspaces":["apps/*"]}\n');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  await mkdir(fixture.path('node_modules', '.bin'), { recursive: true });
  const patchOutput = fixture.path('node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  await mkdir(join(patchOutput, '..'), { recursive: true });
  await writeFile(patchOutput, 'export {};');
  // PM availability is an OS boundary. Keep the real readiness owner while
  // making any unexpected install/build/postinstall invocation fail loudly.
  const pnpmEntrypoint = fixture.path('pnpm.cjs');
  await writeFile(pnpmEntrypoint,
    "if (process.argv[2] === '--version') console.log('12.14.0'); else process.exit(43);\n");
  const stackName = 'scratch-metro';
  const baseDir = fixture.path('stacks', stackName);
  const envPath = join(baseDir, 'env');
  const env = {
    ...sanitizeStackTestRunnerEnv(baseEnv, { isolatedStackRoot: fixture.root }),
    npm_execpath: pnpmEntrypoint,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'),
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    HAPPIER_STACK_EXPO_CLEAR_CACHE: '0',
    HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
    HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
    HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
  };
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  return { ...fixture, uiDir, env, baseDir, envPath, stackName, patchOutput };
}

test('managed development prepares dependencies before acquiring spawn read custody', { timeout: 10000 }, async t => {
  const fixture = await fixtureFor(t);
  const executable = fixture.path('node_modules', '.bin', 'expo');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(executable, 0o755);
  // A child isolates the lock owner: cancellation can terminate a regressed
  // read-to-writer deadlock without leaving a live reader in the test runner.
  const script = `
    import { ensureDevExpoServer } from ${JSON.stringify(new URL('../dev/expo_dev.mjs', import.meta.url).href)};
    import { killProcessTree } from ${JSON.stringify(new URL('../proc/proc.mjs', import.meta.url).href)};
    const children = [];
    let stopping = false;
    const result = await ensureDevExpoServer({ startUi: true,
      uiDir: ${JSON.stringify(fixture.uiDir)}, autostart: { baseDir: ${JSON.stringify(fixture.baseDir)} },
      baseEnv: process.env, apiServerUrl: 'http://127.0.0.1:1', stackMode: true,
      stackName: ${JSON.stringify(fixture.stackName)}, envPath: ${JSON.stringify(fixture.envPath)},
      runtimeStatePath: ${JSON.stringify(join(fixture.baseDir, 'runtime.json'))},
      children, isShuttingDown: () => stopping, quiet: true, spawnOptions: { silent: true } });
    if (!result.ok || children.length !== 1) throw new Error('managed Metro did not start');
    stopping = true;
    await result.close();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
    await Promise.all(children.map(child => child.completion));
  `;
  await run(process.execPath, ['--input-type=module', '-e', script], {
    env: fixture.env, signal: t.signal, ownedProcessGroup: true, stdio: 'ignore', captureFailureDiagnostic: true,
  });
});

test('cold dependency bootstrap imports and refreshes from source with no compiled workspace closure', async (t) => {
  const fixture = await createTempFixture(t, {
    prefix: 'happier-cold-dependency-owner-', parentDir: tmpdir(),
  });
  const sourceDir = fixture.path('apps', 'stack', 'scripts', 'utils');
  for (const source of [
    'proc/dependency_refresh.mjs', 'proc/jsonOwnerFileLock.mjs', 'proc/pids.mjs',
    'proc/workspace_package_manifests.mjs', 'proc/ui_postinstall.mjs', 'proc/workspaceBuildWaitNotifier.mjs',
    'proc/dependency_consumers.mjs', 'fs/fs.mjs', 'fs/json.mjs', 'env/read.mjs', 'env/dotenv.mjs',
    'paths/paths.mjs', 'paths/canonical_home.mjs',
    'dev_targets/stack_paths.mjs', 'stack/runtime_processes.mjs',
    '../runtime/shared/pending_source_start.mjs',
    '../../../../packages/cli-common/fileChangeObserver.mjs',
    '../../../../packages/cli-common/processInstance.mjs',
  ]) {
    const target = join(sourceDir, source);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(new URL(`../${source}`, import.meta.url), target);
  }
  const installDir = fixture.path('install');
  await mkdir(join(installDir, 'node_modules'), { recursive: true });
  await writeFile(join(installDir, 'package.json'), '{"private":true}\n');
  const stoppedStack = fixture.path('stacks', 'stopped');
  await mkdir(stoppedStack, { recursive: true });
  await writeFile(join(stoppedStack, 'env'), `HAPPIER_STACK_REPO_DIR=${installDir}\n`);
  await writeFile(join(stoppedStack, 'stack.runtime.json'), JSON.stringify({ ownerPid: null, processes: { daemonPid: null } }));
  const { withDependencyRefresh: coldRefresh } = await import(pathToFileURL(join(sourceDir, 'proc', 'dependency_refresh.mjs')).href);
  const result = await coldRefresh({ installDir, env: {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }), HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'),
  } }, async () => {});
  assert.equal(result.refreshed, true);
});

for (const invocation of ['spawn', 'exec']) test(`Metro honors explicit dependency refresh suppression (${invocation})`, async t => {
  const fixture = await fixtureFor(t);
  const markerPath = fixture.path('node_modules', '.happier-stack-dependencies-ready');
  const marker = await readFile(markerPath, 'utf8');
  await writeFile(join(fixture.uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', dependencies: { 'new-mid-edit-package': '1.0.0' },
    scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
  }));
  const expoPath = fixture.path('node_modules', '.bin', 'expo');
  await writeFile(expoPath, `#!${process.execPath}\nconsole.log('served');\n`);
  await chmod(expoPath, 0o755);
  const options = { dir: fixture.uiDir, projectDir: fixture.uiDir,
    args: ['start', '--web'], workspacePrepared: true, env: fixture.env, quiet: true,
    options: { silent: true } };
  if (invocation === 'spawn') {
    const child = await expoSpawn(options);
    assert.equal((await child.completion).code, 0);
  } else await expoExec(options);
  assert.equal(await readFile(markerPath, 'utf8'), marker, 'startup must not withdraw or republish install admission');
  assert.equal(await readFile(fixture.patchOutput, 'utf8'), 'export {};');
});

for (const cancel of [false, true]) test(`Metro keeps serving its last-good process while replacement waits for dependency custody (shutdown=${cancel})`, async t => {
  const fixture = await fixtureFor(t);
  const children = [];
  let shuttingDown = false, original, replacement;
  let releaseWriter;
  let replacementStart;
  const held = new Promise(resolve => { releaseWriter = resolve; });
  t.after(async () => {
    releaseWriter();
    await replacementStart?.catch(() => {});
    shuttingDown = true;
    await original?.close?.();
    await replacement?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
  });
  const executable = fixture.path('node_modules', '.bin', 'expo');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:http').createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1');\n`);
  await chmod(executable, 0o755);
  const options = { startUi: true, uiDir: fixture.uiDir, autostart: { baseDir: fixture.baseDir },
    baseEnv: { ...fixture.env, HAPPIER_STACK_EXPO_SUPERVISE_RESTARTS: '0' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: fixture.stackName,
    runtimeStatePath: fixture.path('runtime.json'), envPath: fixture.envPath,
    children, isShuttingDown: () => shuttingDown, quiet: true, spawnOptions: { silent: true } };
  original = await ensureDevExpoServer(options);
  const origin = `http://127.0.0.1:${original.port}`;
  await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  let entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  const writer = withDependencyRefreshLock({ installDir: fixture.root, env: fixture.env }, async () => { entered(); await held; });
  await admitted;
  replacementStart = ensureDevExpoServer({ ...options, restart: true,
    baseEnv: { ...options.baseEnv, HAPPIER_STACK_EXPO_DEV_PORT: String(original.port), HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable' } });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(original.proc.exitCode ?? original.proc.signalCode, null, 'do not stop the incumbent before acquiring dependency custody');
  assert.equal((await fetch(`${origin}/status`)).status, 200, 'last-good Metro must keep serving during the install-lock wait');
  if (cancel) shuttingDown = true;
  releaseWriter();
  await writer;
  if (cancel) {
    await assert.rejects(replacementStart, { name: 'AbortError' });
    assert.equal((await fetch(`${origin}/status`)).status, 200, 'cancelled replacement must not stop the incumbent');
    return;
  }
  replacement = await replacementStart;
  assert.notEqual(replacement.pid, original.pid);
  assert.equal(replacement.port, original.port);
  await waitFor(async () => fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
});

test('bootstrap cache context discovers target-owned legacy Metro before changing its tree', async (t) => {
  const fixture = await fixtureFor(t);
  const targetHome = fixture.path('remote-target-home');
  const targetBase = join(targetHome, 'stack-state', 'dev-target-linux1-fixture');
  const targetEnv = {
    ...fixture.env, HAPPIER_STACK_HOME_DIR: targetHome,
    HAPPIER_STACK_STORAGE_DIR: join(targetHome, 'stack-state'),
    HAPPIER_STACK_ENV_FILE: join(targetBase, 'env'),
  };
  // Native and JavaScript remote bootstrap dispatch currently provide the
  // target-owned cache context, not the running Stack's environment keys.
  const bootstrapEnv = {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }), HAPPIER_STACK_HOME_DIR: '', HAPPIER_STACK_STORAGE_DIR: '',
    HAPPIER_STACK_ENV_FILE: '', HAPPIER_STACK_PM_CACHE_BASE_DIR: join(targetHome, 'cache'),
  };
  const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    env: targetEnv, detached: process.platform !== 'win32', stdio: 'ignore',
  });
  t.after(async () => await killProcessTree(child, 'SIGTERM', { graceMs: 500 }));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const paths = getExpoStatePaths({ baseDir: targetBase, kind: 'expo-dev', projectDir: fixture.uiDir });
  await writePidState(paths.statePath, { pid: child.pid, projectDir: fixture.uiDir, uiDir: fixture.uiDir });
  await withDependencyRefresh({
    installDir: fixture.root, env: bootstrapEnv, onDependenciesReady: async () => {},
  }, async () => assert.fail('warm readiness must not install'));
  assert.equal(child.exitCode, null, 'read-only warm admission must preserve even a legacy serving consumer');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# changed\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  await withDependencyRefresh({
    installDir: fixture.root, env: bootstrapEnv, refreshExisting: false,
    onDependenciesReady: async () => {},
  }, async () => assert.fail('explicit ready-only admission must not install'));
  assert.equal(child.exitCode, null, 'stale source with unchanged outputs is still read-only in no-install mode');
  const markerPath = fixture.path('node_modules', '.happier-stack-dependencies-ready');
  const priorMarker = await readFile(markerPath, 'utf8');
  let mutated = false;
  await assert.rejects(withDependencyRefresh({
    installDir: fixture.root, env: bootstrapEnv,
    onDependenciesReady: async () => { mutated = true; },
  }, async () => { mutated = true; }), { code: 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED' });
  assert.equal(mutated, false);
  assert.equal(await readFile(markerPath, 'utf8'), priorMarker);
  assert.equal(child.exitCode, null);
});

for (const sameName of [false, true]) {
test(`dependency mutation cannot borrow another stack identity to stop its serving Metro (same name: ${sameName})`, async (t) => {
  const fixture = await fixtureFor(t);
  const consumers = [];
  for (const directory of [fixture.stackName, 'unrelated-serving-stack']) {
    const stackName = sameName ? fixture.stackName : directory;
    const baseDir = fixture.path('stacks', directory);
    const envPath = join(baseDir, 'env');
    const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
      env: { ...fixture.env, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath },
      detached: process.platform !== 'win32', stdio: 'ignore',
    });
    t.after(async () => await killProcessTree(child, 'SIGTERM', { graceMs: 500 }));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const paths = getExpoStatePaths({ baseDir, kind: 'expo-dev', projectDir: fixture.uiDir });
    await writePidState(paths.statePath, {
      pid: child.pid, projectDir: fixture.uiDir, uiDir: fixture.uiDir, stackName, envPath,
    });
    consumers.push(child);
  }
  const markerPath = fixture.path('node_modules', '.happier-stack-dependencies-ready');
  const priorMarker = await readFile(markerPath, 'utf8');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# changed\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  let mutated = false;
  await assert.rejects(withDependencyRefresh({ installDir: fixture.root, env: fixture.env }, async () => {
    mutated = true;
  }), { code: 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED' });
  assert.equal(mutated, false, 'shared installed bytes must remain unchanged while another stack is serving them');
  assert.equal(await readFile(markerPath, 'utf8'), priorMarker, 'rejected refresh must retain existing admission');
  for (const child of consumers) assert.equal(child.exitCode ?? child.signalCode, null, 'validate all consumers before stopping any');
  let warning = '';
  t.mock.method(console, 'warn', message => { warning += message; });
  const devEnv = { ...fixture.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1' };
  const result = await ensureDepsInstalled(fixture.uiDir, 'development stack', { env: devEnv, quiet: true });
  assert.equal(result.reason, 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED');
  assert.match(warning, /continuing with installed bytes/);
  assert.equal(await readFile(markerPath, 'utf8'), priorMarker);
  for (const child of consumers) assert.equal(child.exitCode ?? child.signalCode, null);
});
}

for (const gracefulExit of [false, true]) test(`managed Metro stops during dependency mutation and resumes installed bytes after a failed refresh (graceful=${gracefulExit})`, async (t) => {
  const fixture = await fixtureFor(t);
  fixture.env.HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS = '7';
  fixture.env.HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS = '28';
  const restartDelays = [];
  const realSetTimeout = globalThis.setTimeout;
  // Observe the OS timer boundary while retaining real scheduling and the
  // complete supervisor/installer path. Planned exits must not grow backoff.
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if ([7, 14, 28].includes(milliseconds)) restartDelays.push(milliseconds);
    return realSetTimeout(callback, milliseconds, ...args);
  });
  const children = [];
  let shuttingDown = false;
  let result;
  t.after(async () => {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM', { graceMs: 500 });
  });
  const readerScript = fixture.path('metro-reader.cjs');
  const runsPath = fixture.path('reader-runs');
  const observationsPath = fixture.path('partial-observations');
  const dependencyPath = fixture.path('node_modules', 'patched.js');
  await writeFile(dependencyPath, 'patched');
  await writeFile(readerScript, [
    "const fs = require('node:fs');",
    ...(gracefulExit ? ["process.on('SIGTERM', () => process.exit(0));"] : []),
    `fs.appendFileSync(${JSON.stringify(runsPath)}, process.pid + '\\n');`,
    'setInterval(() => {',
    `  if (fs.readFileSync(${JSON.stringify(dependencyPath)}, 'utf8') !== 'patched') {`,
    `    fs.appendFileSync(${JSON.stringify(observationsPath)}, 'partial\\n');`,
    '  }',
    '}, 5);',
  ].join('\n'));
  const expoBin = fixture.path('node_modules', '.bin', process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expoBin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${readerScript}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${readerScript.replaceAll("'", "'\\''")}' "$@"\n`);
  await chmod(expoBin, 0o755);
  result = await ensureDevExpoServer({
    startUi: true, startMobile: false, uiDir: fixture.uiDir,
    autostart: { baseDir: fixture.baseDir }, baseEnv: fixture.env,
    apiServerUrl: 'http://127.0.0.1:1', restart: false, stackMode: true,
    runtimeStatePath: join(fixture.baseDir, 'stack.runtime.json'),
    stackName: fixture.stackName, envPath: fixture.envPath, children,
    spawnOptions: { silent: true }, quiet: true,
    isShuttingDown: () => shuttingDown,
  });
  assert.equal(result.ok, true);
  await waitFor(async () => Boolean(await readFile(runsPath, 'utf8').catch(() => '')));
  const first = children[0];
  await withDependencyRefresh({
    installDir: fixture.root, env: fixture.env, onDependenciesReady: async () => {},
  }, async () => assert.fail('warm readiness must not install'));
  assert.equal(first.exitCode ?? first.signalCode, null, 'unchanged prerequisite inspection must preserve Metro identity');
  await unlink(fixture.patchOutput);
  await withDependencyRefresh({
    installDir: fixture.root, env: fixture.env,
    onDependenciesReady: async () => {
      assert.notEqual(first.exitCode ?? first.signalCode, null, 'consumer must exit before a warm repair starts');
      await writeFile(dependencyPath, 'unpatched');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(children.length, 1, 'the supervisor must not restart during mutation');
      await writeFile(dependencyPath, 'patched');
      await writeFile(fixture.patchOutput, 'export {};');
    },
  }, async () => assert.fail('warm repair must not reinstall'));
  await waitFor(async () => (await readFile(runsPath, 'utf8')).trim().split('\n').length === 2);
  assert.equal(await readFile(observationsPath, 'utf8').catch(() => ''), '');
  const second = children[1];
  // Exercise automatic PM admission with the real supervisor and ownership
  // barrier too; only the package-manager process is a fixture boundary.
  await writeFile(fixture.env.npm_execpath,
    "if (process.argv[2] === '--version') console.log('12.14.0');\n");
  await writeFile(fixture.path('pnpm-lock.yaml'), '# automatic owning refresh\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  await ensureDepsInstalled(fixture.uiDir, 'development stack', { quiet: true,
    env: { ...fixture.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1' } });
  assert.notEqual(second.exitCode ?? second.signalCode, null, 'automatic refresh must stop its owned consumer');
  await waitFor(async () => (await readFile(runsPath, 'utf8')).trim().split('\n').length === 3);
  const third = children[2];
  await unlink(fixture.patchOutput);
  await assert.rejects(withDependencyRefresh({
    installDir: fixture.root, env: fixture.env,
    onDependenciesReady: async () => {
      assert.notEqual(third.exitCode ?? third.signalCode, null);
      await writeFile(dependencyPath, 'unpatched');
      // A late postinstall failure can leave this one patch sentinel usable,
      // while the installation certificate must remain unavailable.
      await writeFile(fixture.patchOutput, 'export {};');
      throw new Error('patch failed');
    },
  }, async () => {}), /patch failed/);
  await waitFor(async () => children.length === 4);
  assert.equal(children[3].exitCode, null, 'a failed refresh must not leave the Metro runner permanently unavailable');
  assert.equal(Math.max(...restartDelays), 7,
    'repeated dependency replacements must retain the base restart delay even when Expo handles SIGTERM and exits with code 0');
});

test('a child killed during its own admission publication still consumes the crash budget', async (t) => {
  let supervisorOutput = '';
  t.mock.method(process.stderr, 'write', chunk => { supervisorOutput += String(chunk); return true; });
  const occupiedPortServer = createServer();
  await new Promise((resolve, reject) => {
    occupiedPortServer.once('error', reject);
    occupiedPortServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => await new Promise(resolve => occupiedPortServer.close(resolve)));
  // A launching Stack's occupied pin must not become the scratch child's port.
  const fixture = await fixtureFor(t, { baseEnv: {
    ...process.env,
    HAPPIER_STACK_EXPO_DEV_PORT: String(occupiedPortServer.address().port),
    HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
  } });
  const children = [];
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    for (const child of children) await killProcessTree(child, 'SIGTERM', { graceMs: 500 });
  });
  const runsPath = fixture.path('admission-crash-runs');
  const readerScript = fixture.path('admission-crash.cjs');
  await writeFile(readerScript, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(runsPath)}, process.pid + '\\n');`,
    "process.kill(process.pid, 'SIGKILL');",
  ].join('\n'));
  const expoBin = fixture.path('node_modules', '.bin', process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expoBin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${readerScript}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${readerScript.replaceAll("'", "'\\''")}' "$@"\n`);
  await chmod(expoBin, 0o755);
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  // Hold the actual filesystem publication boundary, not the supervisor or
  // admission logic. The dependency lock stays held while PID state waits.
  const publicationLock = { lockPath: `${runtimeStatePath}.lock` };
  let startup;
  await withJsonOwnerFileLock(async () => {
    startup = ensureDevExpoServer({
      startUi: true, startMobile: false, uiDir: fixture.uiDir,
      autostart: { baseDir: fixture.baseDir }, baseEnv: {
        ...fixture.env, HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '100',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '100',
      },
      apiServerUrl: 'http://127.0.0.1:1', restart: false, stackMode: true,
      runtimeStatePath, stackName: fixture.stackName, envPath: fixture.envPath,
      children, spawnOptions: { silent: true }, quiet: false,
      isShuttingDown: () => shuttingDown,
    });
    await waitFor(async () => children.length === 1 && children[0].signalCode !== null);
  }, publicationLock);
  await startup;
  await withJsonOwnerFileLock(async () => {
    await waitFor(async () => children.length === 2 && children[1].signalCode !== null);
  }, publicationLock);
  await waitFor(async () => (await readFile(runsPath, 'utf8')).trim().split('\n').length >= 3);
  assert.match(supervisorOutput, /attempt 2/,
    'own spawn-admission lock must not convert a rapid crash loop into planned install transitions');
  assert.doesNotMatch(supervisorOutput, /stopped for dependency refresh/);
  assert.equal(occupiedPortServer.listening, true, 'the invoking Stack port must remain untouched');
});
