import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { createMinimalMonorepoFixture } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { allocateAvailableLocalhostPort } from '../../testkit/core/ephemeral_port.mjs';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDevExpoServer, resolveMetroConfigFingerprint } from './expo_dev.mjs';
import { resolveExpoRestartPolicy } from './expo_dev_supervision.mjs';
import { getExpoStatePaths } from '../expo/expo.mjs';
import { readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { resolveDependencyRefreshMarkerPath, withDependencyRefresh, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { ensureServerGeneratedProviderOutputs } from '../proc/pm.mjs';
import { ensureUiPostinstallOutputs } from '../proc/ui_postinstall.mjs';

test('dependency output preparation and installation preserve a serving Expo',
  { timeout: 15000, skip: process.platform === 'win32' }, async t => {
    const fixture = await createMinimalMonorepoFixture(t, { prefix: 'hstack-expo-server-output-' });
    const { uiDir, serverDir } = fixture;
    await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server',
      scripts: { 'generate:providers': 'node generate.cjs' } }));
    await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
    const executable = join(uiDir, 'node_modules/.bin/expo');
    const listening = fixture.path('listening');
    // Only the Expo executable and package-manager subprocess are replaced.
    // Publication, generation, ownership and termination remain real.
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
require('node:http').createServer((req, res) => res.end('packager-status:running'))
  .listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1',
    () => fs.writeFileSync(${JSON.stringify(listening)}, String(process.pid)));
`);
    await chmod(executable, 0o755);
    const generated = join(serverDir, 'generated-output');
    const generator = fixture.path('generator.cjs');
    await writeFile(generator, `const fs = require('node:fs');
if (process.argv.includes('--check')) process.exit(fs.existsSync(${JSON.stringify(generated)}) ? 0 : 1);
fs.writeFileSync(${JSON.stringify(generated)}, 'server client');
`);
    const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
      HAPPIER_STACK_EXPO_DEV_PORT: String(await allocateAvailableLocalhostPort()),
      HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable' };
    const publicationEnv = { ...env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
    await withDependencyRefresh({ installDir: fixture.root, env: publicationEnv },
      () => mkdir(fixture.path('node_modules'), { recursive: true }));
    const children = [], owners = [];
    const options = { startUi: true, uiDir, autostart: { baseDir: fixture.root }, baseEnv: env,
      stackMode: true, stackName: 'server-output-fixture', envPath: fixture.path('stack.env'),
      children, quiet: true, spawnOptions: { silent: true } };
    let owner;
    t.after(async () => {
      for (const value of owners) await value.close?.();
      for (const child of children) await killProcessTree(child, 'SIGKILL');
      await Promise.all(children.map(child => child.completion));
    });
    owner = await ensureDevExpoServer(options);
    owners.push(owner);
    await t.waitFor(async () => assert.equal(await readFile(listening, 'utf8'), String(owner.pid)));
    const incumbent = owner;
    const signals = [];
    const nativeKill = process.kill;
    t.mock.method(process, 'kill', function (pid, signal) {
      if (Math.abs(pid) === incumbent.pid && signal && signal !== 0) signals.push(signal);
      return nativeKill.call(this, pid, signal);
    });
    const beforeFingerprint = await resolveMetroConfigFingerprint({ projectDir: uiDir, env });
    await ensureServerGeneratedProviderOutputs(serverDir, fixture.root, { env, quiet: true,
      pm: { name: 'pnpm', cmd: process.execPath, prefixArgs: [generator] }, signal: t.signal });
    assert.equal(await readFile(generated, 'utf8'), 'server client');
    assert.equal(signals.filter(signal => signal === 'SIGKILL').length, 0,
      'server-only output generation must not SIGKILL the serving Expo');
    assert.equal(children.length, 1);
    assert.equal(incumbent.proc.signalCode, null);
    assert.equal(await resolveMetroConfigFingerprint({ projectDir: uiDir, env }), beforeFingerprint,
      'the same consumed-output fact also preserves the running Metro cache identity');

    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/app',
      scripts: { 'postinstall:real': 'node tools/postinstall.mjs' } }));
    const uiOutput = fixture.path('node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
    await ensureUiPostinstallOutputs(uiDir, fixture.root, { env, quiet: true,
      runPostinstall: async () => {
        await mkdir(join(uiOutput, '..'), { recursive: true });
        await writeFile(uiOutput, 'export const repaired = true;');
      }, restoreDependencies: async () => assert.fail('a UI output repair must not reinstall packages') });
    assert.equal(children.length, 1, 'a UI dependency repair preserves the serving process');
    assert.equal(incumbent.proc.signalCode, null);
    assert.deepEqual(signals, [], 'dependency preparation must not signal the serving Expo');

    await withDependencyRefresh({ installDir: fixture.root, env: publicationEnv, force: true },
      () => writeFile(fixture.path('node_modules', 'installed.js'), 'module.exports = true;'));
    assert.equal(children.length, 1, 'a forced install preserves the serving process');
    assert.equal(incumbent.proc.signalCode, null);
    assert.deepEqual(signals, []);
  });

test('closing the Expo owner joins a retry already publishing its replacement', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-close-publication-' });
  const uiDir = fixture.path('ui');
  const runtimeStatePath = fixture.path('runtime.json');
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"fake-ui"}');
  const executable = join(uiDir, 'node_modules/.bin/expo');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(executable, 0o755);
  const children = [];
  let result, release, lock, stopping = false;
  t.after(async () => {
    release?.();
    await lock;
    stopping = true;
    await result?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
  });
  result = await ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: fixture.root },
    baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '200',
      HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '200', HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS: '5000' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'scratch-close',
    runtimeStatePath, envPath: '', children, isShuttingDown: () => stopping,
    spawnOptions: { silent: true }, quiet: true });
  await killProcessTree(children[0], 'SIGTERM');
  await waitForCondition(async () => (await readStackRuntimeStateFile(runtimeStatePath))?.processes?.expoPid == null);
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  lock = withJsonOwnerFileLock(async () => { entered(); await held; }, { lockPath: `${runtimeStatePath}.lock` });
  await admitted;
  await waitForCondition(async () => children.length === 2);
  let closed = false;
  const closing = result.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'a replacement owner must wait until the old owner finishes publishing its in-flight child');
  release();
  await lock;
  await closing;
  const state = getExpoStatePaths({ baseDir: fixture.root, kind: 'expo-dev', projectDir: uiDir });
  assert.equal(JSON.parse(await readFile(state.statePath, 'utf8')).pid, children[1].pid);
});

test('Expo supervisor preserves a never-ready live Metro across slow status responses and still restarts an exited child', async t => {
  const { root, cleanup } = await createTempFixture(t, { prefix: 'hstack-expo-unresponsive-', registerCleanup: false });
  const uiDir = join(root, 'ui');
  const children = [];
  let shuttingDown = false;
  let result;
  t.after(async () => {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) killProcessTreeByPid(child.pid);
    await Promise.all(children.map(child => child.completion));
    await cleanup();
  });
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"fake-ui"}');
  const stalledPath = join(root, 'stalled');
  const runCountPath = join(root, 'runs');
  const expoPath = join(uiDir, 'node_modules/.bin/expo');
  await writeFile(stalledPath, 'stalled');
  await writeFile(expoPath, `#!${process.execPath}
const fs = require('node:fs');
const countPath = ${JSON.stringify(runCountPath)};
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1;
fs.writeFileSync(countPath, String(count));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http').createServer((req, res) => {
  if (count === 1 && fs.existsSync(${JSON.stringify(stalledPath)})) {
    fs.writeFileSync(${JSON.stringify(join(root, 'slow-request'))}, 'observed');
    return;
  }
  res.end('packager-status:running');
}).listen(port, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(join(root, 'listening'))}, 'ready'));
`);
  await chmod(expoPath, 0o755);
  let supervisorOutput = '';
  t.mock.method(process.stderr, 'write', chunk => { supervisorOutput += String(chunk); return true; });
  result = await ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: root },
    baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }), HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS: '200', HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS: '20',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'qa-unresponsive',
    runtimeStatePath: join(root, 'runtime.json'), envPath: '', children,
    isShuttingDown: () => shuttingDown, spawnOptions: { silent: true }, quiet: true });
  const origin = `http://127.0.0.1:${result.port}`;
  await waitForCondition(async () => await readFile(join(root, 'listening'), 'utf8').catch(() => '') === 'ready');
  const slowRequest = fetch(`${origin}/status`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  await waitForCondition(async () => await readFile(join(root, 'slow-request'), 'utf8').catch(() => '') === 'observed');
  // The real HTTP process stays alive beyond the configured readiness budget.
  await slowRequest;
  assert.equal(await readRunCount(runCountPath), 1, 'a slow /status response must not trigger a new bundle process');
  assert.equal(children[0].exitCode, null);
  assert.equal(children[0].signalCode, null);
  await rm(stalledPath);
  await waitForCondition(async () => await fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  await killProcessTree(children[0], 'SIGTERM');
  await waitForCondition(async () => await readRunCount(runCountPath) >= 2);
  assert.equal(children[0].exitCode !== null || children[0].signalCode !== null, true);
  await waitForCondition(async () => await fetch(`${origin}/status`).then(r => r.ok).catch(() => false));
  assert.equal(children.length, 2, 'one physical exit admits exactly one replacement');
  assert.equal(supervisorOutput.split('dev Expo restarted (auto)').length - 1, 1);
});

function killProcessTreeByPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return;
  try {
    process.kill(-n, 'SIGKILL');
  } catch {
    try {
      process.kill(n, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

test('closing Expo cancels a replacement waiting for a live dependency writer', { timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-close-writer-', registerCleanup: false });
  const uiDir = fixture.path('ui');
  const children = [];
  let result, writer, releaseWriter;
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    releaseWriter?.();
    await writer;
    await result?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
    await Promise.all(children.map(child => child.completion));
    await fixture.cleanup();
  });
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"close-writer-fixture"}');
  const executable = join(uiDir, 'node_modules/.bin/expo');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(executable, 0o755);
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
    HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10' };
  result = await ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: fixture.root },
    baseEnv: env, apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'close-writer',
    envPath: '', children, isShuttingDown: () => shuttingDown, quiet: true, spawnOptions: { silent: true } });
  let entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  writer = withDependencyRefreshLock({ installDir: uiDir, env }, async () => {
    entered(); await new Promise(resolve => { releaseWriter = resolve; });
  });
  await admitted;
  await killProcessTree(children[0], 'SIGTERM');
  await children[0].completion;
  // Pass the fixture's restart backoff so the replacement is waiting on the
  // actual writer, rather than merely cancelling a not-yet-fired restart.
  await new Promise(resolve => setTimeout(resolve, 200));
  const closing = result.close();
  const closed = await Promise.race([closing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
  releaseWriter();
  await writer;
  await closing;
  assert.equal(closed, true, 'closing must cancel dependency admission without waiting for another lifecycle owner');
  assert.equal(children.length, 1, 'a cancelled admission must not spawn a replacement');
});

async function waitForCondition(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function readRunCount(runCountPath) {
  const raw = await readFile(runCountPath, 'utf-8').catch(() => '0');
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

for (const failure of ['spawn permissions', 'cold preparation lock', 'dependency manifest', 'state publication']) {
  test(`Expo automatically recovers an abandoned ${failure} start after repair`, { timeout: 15000 }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-expo-abandoned-start-', registerCleanup: false });
    const uiDir = fixture.path('ui');
    const children = [];
    let result, startup, releaseWriter, writer;
    let shuttingDown = false;
    t.after(async () => {
      shuttingDown = true;
      releaseWriter?.();
      await writer;
      await startup?.catch(() => {});
      await result?.close?.();
      for (const child of children) await killProcessTree(child, 'SIGTERM');
      await Promise.all(children.map(child => child.completion));
      await fixture.cleanup();
    });
    await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), '{"name":"abandoned-start-fixture"}');
    const executable = join(uiDir, 'node_modules/.bin/expo');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const previous = ${JSON.stringify(fixture.path('previous-pid'))};
if (fs.existsSync(previous)) {
  try { process.kill(Number(fs.readFileSync(previous, 'utf8')), 0); fs.writeFileSync(${JSON.stringify(fixture.path('overlap'))}, 'overlap'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
fs.writeFileSync(previous, String(process.pid));
require('node:http').createServer((req, res) => res.end('packager-status:running'))
  .listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
    await chmod(executable, failure === 'spawn permissions' ? 0o644 : 0o755);
    const blocked = fixture.path('blocked');
    const attempted = fixture.path('attempted');
    if (failure === 'cold preparation lock') {
      await mkdir(join(uiDir, 'scripts'));
      await writeFile(blocked, 'locked');
      await writeFile(join(uiDir, 'scripts/ensureWorkspacePackagesBuilt.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
export async function ensureUiWorkspacePackagesBuilt() {
  writeFileSync(${JSON.stringify(attempted)}, 'attempted');
  if (existsSync(${JSON.stringify(blocked)})) {
    const error = new Error('Dependency preparation writer is busy');
    error.code = 'EJSONOWNERLOCKBUSY';
    throw error;
  }
}
`);
    }
    if (failure === 'dependency manifest') await writeFile(join(uiDir, 'package.json'), '{');
    const statePath = getExpoStatePaths({ baseDir: fixture.root, kind: 'expo-dev', projectDir: uiDir }).statePath;
    if (failure === 'state publication') await mkdir(statePath, { recursive: true });
    let output = '';
    t.mock.method(process.stderr, 'write', chunk => { output += String(chunk); return true; });
    let outcome = 'pending', startupError;
    const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '100', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '100' };
    startup = ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: fixture.root },
      baseEnv: env, apiServerUrl: 'http://127.0.0.1:1', stackMode: true,
      stackName: 'abandoned-start', envPath: '', children, isShuttingDown: () => shuttingDown,
      spawnOptions: { silent: true } });
    void startup.then(value => { result = value; outcome = 'started'; }, error => { startupError = error; outcome = 'failed'; });
    await waitForCondition(async () => outcome === 'failed' || output.includes('retrying'));
    if (startupError) {
      if (failure === 'dependency manifest') assert.equal(startupError.name, 'SyntaxError');
      else assert.equal(startupError.code, { 'spawn permissions': 'EACCES',
        'cold preparation lock': 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED',
        'state publication': 'EISDIR' }[failure], 'RED must reach the intended startup boundary');
    }
    assert.equal(outcome, 'pending', 'a failed start must remain supervised until repair');
    assert.equal(children.length, failure === 'state publication' ? 1 : 0);
    if (failure === 'cold preparation lock') {
      assert.equal(await readFile(attempted, 'utf8'), 'attempted');
      let entered;
      const admitted = new Promise(resolve => { entered = resolve; });
      writer = withDependencyRefreshLock({ installDir: uiDir, env }, async () => {
        entered();
        await new Promise(resolve => { releaseWriter = resolve; });
      });
      await admitted;
      await rm(blocked);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(outcome, 'pending');
      assert.equal(children.length, 0, 'a retry cannot race an active dependency writer');
      releaseWriter();
      await writer;
    } else if (failure === 'dependency manifest') {
      await writeFile(join(uiDir, 'package.json'), '{"name":"abandoned-start-fixture"}');
    } else if (failure === 'state publication') {
      await rm(statePath, { recursive: true });
    } else {
      await chmod(executable, 0o755);
    }
    result = await startup;
    await waitForCondition(async () => await fetch(`http://127.0.0.1:${result.port}/status`).then(r => r.ok).catch(() => false));
    // Observe beyond both 100ms fixture backoffs: attaching an exit retry to
    // failed publication as well as the startup retry must create a third child.
    if (failure === 'state publication') await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(children.length, failure === 'state publication' ? 2 : 1);
    for (const child of children.slice(0, -1)) assert.ok(child.exitCode !== null || child.signalCode !== null);
    await assert.rejects(readFile(fixture.path('overlap')), { code: 'ENOENT' });
    assert.equal(output.split('dev Expo restarted (auto)').length - 1, 1, 'one successful recovery produces one restart notice');
  });
}

test('resolveExpoRestartPolicy rejects positive fractions that floor to zero', () => {
  const policy = resolveExpoRestartPolicy({
    stackMode: true,
    env: {
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '0.5',
      HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '0.5',
      HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS: '0.5',
    },
  });

  assert.equal(policy.baseDelayMs, 1_000);
  assert.equal(policy.maxDelayMs, 30_000);
  assert.equal(policy.stabilityWindowMs, 60_000);
});

test('initial Metro spawn remains pending until a missing installed executable is repaired', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-initial-recovery-', registerCleanup: false });
  const uiDir = fixture.path('ui');
  const children = [];
  let result;
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) killProcessTreeByPid(child.pid);
    await Promise.all(children.map(child => child.completion));
    await fixture.cleanup();
  });
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"missing-executable-fixture"}');
  let outcome = 'pending';
  const startup = ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: fixture.root },
    // This fixture repairs its installed executable directly; a real package
    // manager refresh would remove that boundary while startup is retrying.
    baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }), HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'qa-initial-recovery',
    envPath: '', runtimeStatePath: null, children, isShuttingDown: () => shuttingDown,
    quiet: true, spawnOptions: { silent: true } });
  void startup.then(value => { result = value; outcome = 'started'; }, () => { outcome = 'failed'; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(outcome, 'pending', 'the runner must not give up before dependencies can be repaired');
  const executable = join(uiDir, 'node_modules/.bin/expo');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(executable, 0o755);
  result = await startup;
  assert.ok(result.pid > 1);
});

test('Expo crashes three times then recovers when dependencies heal without a source edit', async t => {
  const { root, cleanup } = await createTempFixture(t, { prefix: 'hstack-expo-admission-recovery-', registerCleanup: false });
  const children = [];
  let result;
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) killProcessTreeByPid(child.pid);
    await Promise.all(children.map(child => child.completion));
    await cleanup();
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  const uiDir = join(root, 'apps', 'ui');
  await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(root, 'node_modules'));
  await withDependencyRefresh({ installDir: root }, async () => {});
  const runCountPath = join(root, 'runs');
  const healthyPath = join(root, 'node_modules', 'dependency-healthy');
  const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
  await writeFile(expoBin, `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(runCountPath)};
fs.writeFileSync(path, String(Number(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : 0) + 1));
if (!fs.existsSync(${JSON.stringify(healthyPath)})) process.exit(1);
setInterval(() => {}, 1000);
`);
  await chmod(expoBin, 0o755);
  // Capture the real supervisor's OS output to identify suppression before
  // repairing readiness; no internal readiness or restart logic is mocked.
  let supervisorOutput = '';
  t.mock.method(process.stderr, 'write', chunk => { supervisorOutput += String(chunk); return true; });
  result = await ensureDevExpoServer({
    startUi: true, uiDir, autostart: { baseDir: root },
    baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }), HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
      HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '2', HAPPIER_STACK_DEV_RELOAD_POLL_MS: '50',
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), HAPPIER_STACK_ENV_FILE: '' },
    apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'qa-admission-recovery',
    runtimeStatePath: join(root, 'stack.runtime.json'), envPath: '', children,
    isShuttingDown: () => shuttingDown, spawnOptions: { silent: true }, quiet: false,
  });
  await waitForCondition(async () => await readRunCount(runCountPath) >= 3 && children[2]?.exitCode === 1);
  await writeFile(healthyPath, 'ready');
  await waitForCondition(async () => await readRunCount(runCountPath) >= 4 && children.at(-1)?.exitCode === null);
  assert.equal(children.at(-1).exitCode, null, 'dependency repair must resume the supervised process without a Stack restart');
});

for (const repair of ['source', 'dependency readiness', 'missing dependency readiness']) test(`Expo keeps retrying across repaired ${repair} inputs without restarting the stack`, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-input-recovery-'));
  const children = [];
  let result;
  let shuttingDown = false;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
    const manifestPath = join(uiDir, 'package.json');
    await writeFile(manifestPath, JSON.stringify({ name: 'fake-ui', private: true }));
    const { resolveDependencyRefreshMarkerPath } = await import('../proc/dependency_refresh.mjs');
    const markerPath = resolveDependencyRefreshMarkerPath(uiDir);
    if (repair !== 'missing dependency readiness') await writeFile(markerPath, 'not-ready');
    const runCountPath = join(tmp, 'runs');
    const expoBin = join(uiDir, 'node_modules/.bin/expo');
    await writeFile(expoBin, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const path = ${JSON.stringify(runCountPath)};`,
      "const count = Number(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : 0) + 1;",
      "fs.writeFileSync(path, String(count));",
      'if (count <= 2) process.exit(0);',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    await chmod(expoBin, 0o755);
    result = await ensureDevExpoServer({
      startUi: true, uiDir, autostart: { baseDir: tmp },
      baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }), HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1', HAPPIER_STACK_DEV_RELOAD_POLL_MS: '50' },
      apiServerUrl: 'http://127.0.0.1:1', stackMode: true, stackName: 'qa-input-recovery',
      runtimeStatePath: join(tmp, 'stack.runtime.json'), envPath: '', children,
      isShuttingDown: () => shuttingDown, spawnOptions: { silent: true }, quiet: true,
    });
    await waitForCondition(async () => await readRunCount(runCountPath) === 2 && children[1]?.exitCode === 0);
    // The old supervisor permanently suppressed retries here. Recovery no
    // longer needs a watched edit, but still accepts ordinary input repairs.
    if (repair === 'source') {
      await writeFile(manifestPath, JSON.stringify({ name: 'fake-ui', private: true, repaired: true }));
    } else {
      await writeFile(markerPath, 'ready');
    }
    await waitForCondition(async () => await readRunCount(runCountPath) === 3);
    assert.equal(children[2].exitCode, null);
  } finally {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) killProcessTreeByPid(child?.pid);
    await Promise.all(children.map(child => child.completion));
    if (result) await waitForCondition(async () => {
      const state = await readStackRuntimeStateFile(join(tmp, 'stack.runtime.json'));
      return state?.processes?.expoPid == null;
    });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer restarts Expo after a Node heap OOM abort', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-oom supervision-'));
  const children = [];
  let result;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const argsPath = join(tmp, 'expo-args.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const argsPath = process.env.FAKE_EXPO_ARGS_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "fs.appendFileSync(argsPath, JSON.stringify({ args: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS }) + '\\n');",
        "if (current === 1) {",
        "  console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');",
        "  process.kill(process.pid, 'SIGABRT');",
        '}',
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        FAKE_EXPO_ARGS_PATH: argsPath,
        HAPPIER_STACK_EXPO_CLEAR_CACHE: '0',
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-oom-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);

    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2 && children.length >= 2);
    const launches = (await readFile(argsPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const launch of launches) {
      assert.ok(launch.nodeOptions.includes('--heapsnapshot-near-heap-limit=1'), 'each Metro launch captures one near-limit heap snapshot');
      assert.ok(launch.nodeOptions.includes(`--diagnostic-dir=${JSON.stringify(join(tmp, 'logs'))}`), 'snapshots belong to this stack logs directory');
      assert.ok(launch.nodeOptions.includes('--max-old-space-size=8192'), 'diagnostics do not raise the heap limit');
    }
    const spawnedArgs = launches.map(launch => launch.args);
    assert.equal(spawnedArgs.length, 2);
    assert.equal(spawnedArgs[0].includes('--clear'), false);
    assert.equal(spawnedArgs[1].includes('--clear'), false);
    assert.equal(children.length, 2);
    assert.equal(children[0].signalCode, 'SIGABRT');
    assert.equal(children[1].exitCode, null);

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    await waitForCondition(async () => {
      const state = JSON.parse(await readFile(paths.statePath, 'utf-8').catch(() => '{}'));
      return state.pid === children[1].pid;
    });
    const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(state.pid, children[1].pid);
  } finally {
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer restarts Expo after an unexpected SIGKILL while the stack owner is alive', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-sigkill-supervision-'));
  const children = [];
  let result;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "if (current === 1) {",
        "  process.kill(process.pid, 'SIGKILL');",
        '}',
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-sigkill-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);

    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2 && children.length >= 2);
    assert.equal(children.length, 2);
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(children[1].exitCode, null);

    await waitForCondition(async () => {
      const runtime = await readStackRuntimeStateFile(runtimeStatePath);
      return runtime?.processes?.expoPid === children[1].pid;
    });
    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtime?.processes?.expoPid, children[1].pid);
    assert.equal(runtime?.expo?.webPort, expoPort);
  } finally {
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer restores the restart budget after a replacement remains stable', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-stable-restart-budget-'));
  const children = [];
  let result;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "if (current === 1) {",
        "  process.kill(process.pid, 'SIGKILL');",
        '}',
        "if (current === 2) {",
        "  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 120);",
        '}',
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
        HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS: '50',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-stable-restart-budget',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);
    await waitForCondition(
      async () => (await readRunCount(runCountPath)) >= 3 && children.length >= 3,
      { timeoutMs: 2_000 },
    );
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(children[1].signalCode, 'SIGKILL');
    assert.equal(children[2].exitCode, null);
  } finally {
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer continues capped backoff when the stability override is zero', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-zero-stability-window-'));
  const children = [];
  let result;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "if (current === 1) process.kill(process.pid, 'SIGKILL');",
        "if (current === 2) setTimeout(() => process.kill(process.pid, 'SIGKILL'), 25);",
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
        HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS: '0',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-zero-stability-window',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);
    await waitForCondition(
      async () => (await readRunCount(runCountPath)) >= 2 && children[1]?.signalCode === 'SIGKILL',
      { timeoutMs: 2_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    await waitForCondition(async () => await readRunCount(runCountPath) === 3);
    assert.equal(children.length, 3);
  } finally {
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer clears published UI runtime metadata without restarting during stack shutdown', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-shutdown-supervision-'));
  const children = [];
  let result;
  let shuttingDown = false;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-shutdown-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      isShuttingDown: () => shuttingDown,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);
    await waitForCondition(async () => (await readRunCount(runCountPath)) === 1);

    shuttingDown = true;
    process.kill(children[0].pid, 'SIGTERM');

    await waitForCondition(async () => children[0].signalCode === 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(await readRunCount(runCountPath), 1);
    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtime?.processes?.expoPid, null);
    assert.equal(runtime?.expo?.port, null);
    assert.equal(runtime?.expo?.webPort, null);
    assert.equal(runtime?.expo?.mobilePort, null);
  } finally {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer retries after a transient replacement spawn failure', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-transient-spawn-failure-'));
  const children = [];
  let result;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const expoSource = [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
      "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
      "fs.writeFileSync(runCountPath, String(current));",
      "if (current === 1) {",
      "  fs.unlinkSync(process.argv[1]);",
      "  process.kill(process.pid, 'SIGKILL');",
      '}',
      'setInterval(() => {}, 1000);',
    ].join('\n') + '\n';
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    const teeFile = join(tmp, 'expo.log');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '40',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '40',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '2',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-transient-spawn-failure',
      envPath,
      children,
      spawnOptions: {
        silent: true,
        teeFile,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);
    await waitForCondition(async () => children[0]?.signalCode === 'SIGKILL');
    await children[0].completion;
    await rm(teeFile, { force: true });
    await waitForCondition(async () => {
      return await readFile(teeFile, 'utf-8').then(
        () => true,
        () => false,
      );
    });
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);

    await waitForCondition(
      async () => (await readRunCount(runCountPath)) >= 2 && children.some((child) => Number(child?.pid) > 1 && child.exitCode === null),
      { timeoutMs: 2_000 },
    );
    assert.equal(await readRunCount(runCountPath), 2);
  } finally {
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer does not retry a replacement spawn failure after shutdown begins during backoff', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-spawn-failure-shutdown-'));
  const children = [];
  let result;
  let shuttingDown = false;
  try {
    const expoPort = await allocateAvailableLocalhostPort();
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const expoSource = [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
      "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
      "fs.writeFileSync(runCountPath, String(current));",
      "if (current === 1) {",
      "  fs.unlinkSync(process.argv[1]);",
      "  process.kill(process.pid, 'SIGKILL');",
      '}',
      'setInterval(() => {}, 1000);',
    ].join('\n') + '\n';
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    const teeFile = join(tmp, 'expo.log');
    result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: uiDir }),
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: String(expoPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '300',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '300',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '2',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-spawn-failure-shutdown',
      envPath,
      children,
      spawnOptions: {
        silent: true,
        teeFile,
      },
      isShuttingDown: () => shuttingDown,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, expoPort);
    await waitForCondition(async () => children[0]?.signalCode === 'SIGKILL');
    await children[0].completion;
    await rm(teeFile, { force: true });
    await waitForCondition(async () => {
      return await readFile(teeFile, 'utf-8').then(
        () => true,
        () => false,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    shuttingDown = true;
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);
    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(await readRunCount(runCountPath), 1);
    assert.equal(children.length, 1);
    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtime?.processes?.expoPid, null);
    assert.equal(runtime?.expo?.port, null);
  } finally {
    shuttingDown = true;
    await result?.close?.();
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await Promise.all(children.map(child => child.completion));
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
