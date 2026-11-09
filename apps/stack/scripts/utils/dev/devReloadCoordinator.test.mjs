import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync, { writeFileSync, readFileSync, watch } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { createMinimalMonorepoFixture } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { run } from '../proc/proc.mjs';
import { BuildInputDriftError } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';

import {
  createDevDependencyReload,
  isDevStartupSourceDrift,
  prepareDevComponent,
  prepareSourceComponent,
  requestInitialDevRefreshes,
  startDevReloadCoordinator,
} from './devReloadCoordinator.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { createHappyCliReloadDescriptors, createHappyCliReloadExecutor, prepareDevDaemonSourceRuntime } from './daemon.mjs';
import { createDevServerReloadDescriptors, createDevServerReloadExecutor, createDevServerReloadPlan } from './server.mjs';
import { readHappyCliRuntimeInputFreshness } from '../proc/cli_runtime_inputs.mjs';
import { inspectDependencyRefresh, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';

test('dependency reload descriptor ignores non-install edits and consumes real install changes once', async t => {
  const fixture = await createMinimalMonorepoFixture(t, { prefix: 'hstack-dependency-descriptor-' });
  const manifest = { private: true, workspaces: ['apps/*'], scripts: { 'test:unit': 'first' } };
  await fs.writeFile(fixture.path('package.json'), JSON.stringify(manifest));
  await fs.writeFile(fixture.path('pnpm-lock.yaml'), '# initial\n');
  await fs.writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await fs.mkdir(fixture.path('node_modules'));
  await fs.mkdir(fixture.path('patches'));
  const installed = fixture.path('installed');
  const pnpm = fixture.path('pnpm.cjs');
  await fs.writeFile(pnpm, [
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') console.log('12.14.0');",
    `else fs.appendFileSync(${JSON.stringify(installed)}, 'install\\n');`,
  ].join('\n'));
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
    npm_execpath: pnpm, HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1' };
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const reload = await createDevDependencyReload({ repoDir: fixture.root, env });
  let watcher;
  const admissions = [], failures = [];
  const coordinator = startDevReloadCoordinator({ descriptors: [reload.descriptor],
    executors: [{ ...reload.executor, emitTransitionEvent(event, detail) {
      if (event === 'source_generation_admitted') admissions.push(detail);
    } }], logger: { log() {}, warn() {}, error(message) { failures.push(message); } },
  }, { watchDebouncedImpl(options) { watcher = options; return { close() {} }; } });
  t.after(() => coordinator.close());
  await coordinator.requestReload('dependencies');
  admissions.length = 0;
  manifest.scripts['test:unit'] = 'second';
  await fs.writeFile(fixture.path('package.json'), JSON.stringify(manifest, null, 2));
  await watcher.onChange({ eventType: 'change', watchPath: fixture.path('package.json'), filename: 'package.json' });
  await fs.writeFile(fixture.path('patches', 'unregistered.patch'), 'not an install input');
  await watcher.onChange({ eventType: 'rename', watchPath: fixture.path('patches'), filename: 'unregistered.patch' });
  assert.equal(admissions.length, 0, 'non-install edits must admit zero dependency generations');
  await fs.writeFile(fixture.path('pnpm-lock.yaml'), '# real change\n');
  await watcher.onChange({ eventType: 'change', watchPath: fixture.path('pnpm-lock.yaml'), filename: 'pnpm-lock.yaml' });
  await watcher.onChange({ eventType: 'change', watchPath: fixture.path('pnpm-lock.yaml'), filename: 'pnpm-lock.yaml' });
  assert.equal(admissions.length, 1, 'a real install input change admits one dependency generation');
  assert.equal((await fs.readFile(installed, 'utf8')).trim(), 'install');
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
  assert.deepEqual(failures, []);
});

test('dependency publication exhausted trailing pass is terminal for source startup', () => {
  const error = new BuildInputDriftError('dependencies changed during both attempts', { trailingPassExhausted: true });
  assert.equal(isDevStartupSourceDrift(error, 'expo'), false);
  assert.equal(isDevStartupSourceDrift(error, 'daemon'), false);
});

test('failure diagnostic publication cannot replace the compiler refusal', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refusal-publication-' });
  const stackBaseDir = fixture.path('not-a-directory');
  await fs.writeFile(stackBaseDir, 'obstructed diagnostic output');
  const original = Object.assign(new Error('compiler module failed'), { firstFailingModule: fixture.path('authored-module.ts') });
  await assert.rejects(prepareSourceComponent({ repoDir: fixture.root, stackBaseDir, target: 'daemon',
    waitForSourceChanges: false,
    // The compiler is a system boundary; the real preparation/refusal owners remain active.
    prepare: async () => { throw original; } }), error => error === original);
});

test('development input changes refresh installed dependencies before source builds through the reload owner', async t => {
  const fixture = await createMinimalMonorepoFixture(t, { prefix: 'hstack-dev-auto-deps-' });
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await fs.writeFile(fixture.path('pnpm-lock.yaml'), '# initial\n');
  await fs.writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await fs.mkdir(fixture.path('node_modules'));
  await fs.mkdir(fixture.path('patches'));
  const pnpm = fixture.path('pnpm.cjs');
  const installed = fixture.path('installed');
  await fs.writeFile(pnpm, [
    "const fs = require('node:fs');",
    "if (process.argv[2] === '--version') console.log('12.14.0');",
    `else fs.appendFileSync(${JSON.stringify(installed)}, process.argv.slice(2).join(' ') + '\\n');`,
  ].join('\n'));
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
    npm_execpath: pnpm, HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1' };
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  await fs.writeFile(fixture.path('pnpm-lock.yaml'), '# stale at startup\n');
  await fs.writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  let watcher;
  let sourceBuilds = 0;
  const failures = [];
  const paths = [fixture.path('pnpm-lock.yaml'), fixture.path('package.json'),
    join(fixture.serverDir, 'package.json'), fixture.path('patches')];
  const dependencyReload = await createDevDependencyReload({ repoDir: fixture.root, env });
  const coordinator = startDevReloadCoordinator({
    descriptors: [dependencyReload.descriptor, { id: 'server:inputs', target: 'server', paths }],
    executors: [
      dependencyReload.executor,
      { target: 'server', async build() {
        assert.equal((await inspectDependencyRefresh({ installDir: fixture.root })).required, false,
          'source builds must see the freshly admitted installation');
        sourceBuilds++;
      } },
    ],
    logger: { log() {}, warn() {}, error(message) { failures.push(message); } },
  }, { watchDebouncedImpl(options) { watcher = options; return { close() {} }; } });
  t.after(() => coordinator.close());
  await Promise.all(requestInitialDevRefreshes({ reloadWatcher: coordinator,
    dependencyReloadEnabled: true, serverReloadEnabled: true }));
  for (const [path, bytes] of [
    [fixture.path('pnpm-lock.yaml'), '# changed\n'],
    [fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'], dependencies: { fresh: '1' } })],
    [join(fixture.serverDir, 'package.json'), JSON.stringify({ name: '@fixture/server', dependencies: { fresh: '2' } })],
    [fixture.path('patches/new.patch'), 'new patch'],
  ]) {
    await fs.writeFile(path, bytes);
    await watcher.onChange({ eventType: 'change', filename: path });
  }
  assert.deepEqual(failures, []);
  assert.equal(sourceBuilds, 5);
  assert.equal((await fs.readFile(installed, 'utf8')).trim().split('\n').filter(line => line.startsWith('install')).length, 4,
    'an unregistered patch file does not change the install identity');
  await watcher.onChange({ eventType: 'poll', filename: null });
  assert.equal(sourceBuilds, 5, 'unchanged inputs do not trigger another refresh');
  await coordinator.close();

  // UI-only/no-watch startup must also perform real dependency admission.
  await fs.writeFile(fixture.path('pnpm-lock.yaml'), '# UI-only startup\n');
  await fs.writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  const uiReload = await createDevDependencyReload({ repoDir: fixture.root, env });
  const uiCoordinator = startDevReloadCoordinator({ observeChanges: false,
    descriptors: [uiReload.descriptor], executors: [uiReload.executor],
    logger: { log() {}, warn() {}, error(message) { failures.push(message); } },
  });
  t.after(() => uiCoordinator.close());
  await Promise.all(requestInitialDevRefreshes({ reloadWatcher: uiCoordinator, dependencyReloadEnabled: true }));
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root })).required, false);
  assert.deepEqual(failures, []);
});

test('no-watch startup refresh uses the reload owner without installing source watchers', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-once-refresh-' });
  await fs.writeFile(fixture.path('package.json'), '{}');
  let watching = false;
  let builds = 0;
  const failures = [];
  const coordinator = startDevReloadCoordinator({
    observeChanges: false,
    descriptors: [{ id: 'daemon:cli', target: 'daemon', paths: [fixture.path('package.json')] }],
    executors: [{ target: 'daemon', async build() { builds++; throw new Error('Missing bundled internal workspace dependencies: @happier-dev/email-transports-protocol'); } }],
    logger: { log() {}, error(message) { failures.push(message); } },
  }, { watchDebouncedImpl() { watching = true; return { close() {} }; } });
  t.after(() => coordinator.close());
  await coordinator.requestReload('daemon');
  assert.equal(watching, false);
  assert.equal(builds, 1);
  assert.match(failures.join('\n'), /daemon reload build failed/);
  assert.match(failures.join('\n'), /email-transports-protocol/);
});

test('source daemon preparation observes corrections to its UI compiler inputs', { timeout: 10000 }, async t => {
  const activeWatchers = new Set();
  const originalWatch = fsSync.watch;
  t.mock.method(fsSync, 'watch', (...args) => {
    const native = originalWatch(...args);
    activeWatchers.add(native);
    native.once('close', () => activeWatchers.delete(native));
    return native;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const fixture = await createTempFixture(t, { prefix: 'hstack-daemon-ui-inputs-', registerCleanup: false });
  const repoDir = fixture.path('repo');
  const uiDir = join(repoDir, 'apps/ui');
  const compiler = join(uiDir, 'scripts/prepareSourcePluginUiArtifacts.mjs');
  const uiPackage = join(uiDir, 'package.json');
  await fs.mkdir(join(uiDir, 'scripts'), { recursive: true });
  await fs.mkdir(join(repoDir, 'apps/cli'), { recursive: true });
  await fs.mkdir(join(repoDir, 'packages'));
  await fs.writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  await fs.writeFile(compiler, 'export const ready = ;');
  await fs.writeFile(uiPackage, JSON.stringify({ name: '@happier-dev/ui', version: 'broken' }));
  const abort = new AbortController();
  let completion;
  t.after(async () => { abort.abort(); await completion; await fs.rm(fixture.root, { recursive: true, force: true }); });
  let reportFailure;
  const failure = () => new Promise(resolve => { reportFailure = resolve; });
  let failed = failure();
  const preparing = prepareSourceComponent({ repoDir, target: 'daemon', signal: abort.signal,
    logger: { log() {}, warn() {}, error() { reportFailure(); } },
    async prepare() {
      // The compiler process is the system boundary. Keep input discovery,
      // source-drift admission and the actual filesystem watcher real.
      await run(process.execPath, ['--check', compiler], { captureFailureDiagnostic: true, stdio: 'ignore' });
      await run(process.execPath, ['--input-type=module', '-e',
        'import {readFileSync} from "node:fs"; if (JSON.parse(readFileSync(process.argv[1], "utf8")).version !== "0.0.0") { console.error("compiler.ts(1,1): error TS2307: UI compiler package mismatch"); process.exit(1); }', uiPackage], { captureFailureDiagnostic: true, stdio: 'ignore' });
      return { ready: true };
    },
  });
  completion = preparing.then(result => ({ result }), error => ({ error }));
  await failed;
  assert.ok(activeWatchers.size > 0, 'pending daemon preparation owns native observations');
  t.diagnostic('Observed compiler-process failure; correcting only its UI script input');
  failed = failure();
  await fs.writeFile(compiler, 'export const ready = true;');
  await failed;
  t.diagnostic('Observed package-input failure after script recovery; correcting only the UI package input');
  await fs.writeFile(uiPackage, JSON.stringify({ name: '@happier-dev/ui', version: '0.0.0' }));
  assert.deepEqual(await completion, { result: { ready: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activeWatchers.size, 0, 'a successful daemon snapshot retains no native watcher');
});

test('wrapped and unwrapped compiler exits recover, but environment and configuration exits fail fast', async () => {
  for (const diagnostic of ['ENOSPC: no space left on device', 'Invalid build configuration']) {
    let failure;
    try {
      await run(process.execPath, ['-e', `console.error(${JSON.stringify(diagnostic)}); process.exit(23)`], { captureFailureDiagnostic: true, stdio: 'ignore' });
    } catch (error) { failure = error; }
    assert.equal(failure.code, 'EEXIT');
    const wrapped = Object.assign(new Error('UI preflight failed', { cause: failure }), {
      code: 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED',
    });
    for (const target of ['expo', 'server', 'daemon']) {
      assert.equal(isDevStartupSourceDrift(failure, target), false);
      assert.equal(isDevStartupSourceDrift(wrapped, target), false);
    }
  }
  for (const message of ['SyntaxError: Unexpected token', 'src/index.ts(1,1): error TS2307: Cannot find module']) {
    const cause = Object.assign(new Error(message), { code: 'EEXIT' });
    const wrapped = Object.assign(new Error('UI preflight failed', { cause }), {
      code: 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED',
    });
    assert.equal(isDevStartupSourceDrift(cause, 'expo'), true);
    assert.equal(isDevStartupSourceDrift(wrapped, 'expo'), true);
  }
});

test('server startup recovery observes transitive workspace inputs, not unrelated packages', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-server-transitive-recovery-' });
  const serverDir = fixture.path('apps/server');
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await fs.writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  for (const [path, name, dependencies] of [
    ['apps/server', '@fixture/server', { '@happier-dev/plugin-ui': 'workspace:*' }],
    ['packages/plugin-ui', '@happier-dev/plugin-ui', { '@happier-dev/plugin-sdk': 'workspace:*' }],
    ['packages/plugin-sdk', '@happier-dev/plugin-sdk', {}],
    ['packages/unrelated', '@happier-dev/unrelated', {}],
  ]) {
    await fs.mkdir(fixture.path(path, 'src'), { recursive: true });
    await fs.writeFile(fixture.path(path, 'package.json'), JSON.stringify({ name, dependencies }));
  }
  const source = fixture.path('packages/plugin-sdk/src/index.mjs');
  await fs.writeFile(source, 'export const value = ;');
  const abort = new AbortController();
  let completion;
  t.after(async () => { abort.abort(); await completion; });
  let reportFailure;
  const failed = new Promise(resolve => { reportFailure = resolve; });
  let attempts = 0;
  completion = prepareDevComponent({ enabled: true, target: 'server',
    descriptors: await createDevServerReloadDescriptors({ serverDir }),
    signal: abort.signal, debounceMs: 5,
    logger: { log() {}, warn() {}, error() { reportFailure(); } },
    async prepare() {
      attempts += 1;
      await run(process.execPath, ['--check', source], { captureFailureDiagnostic: true, stdio: 'ignore' });
      return { ready: true };
    },
  }).then(result => ({ result }), error => ({ error }));
  await failed;
  await fs.writeFile(fixture.path('packages/unrelated/src/index.mjs'), 'export const unrelated = true;');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts, 1);
  const recovered = new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 2000);
    completion.then(result => { clearTimeout(timer); resolve(result); });
  });
  await fs.writeFile(source, 'export const value = true;');
  assert.deepEqual(await recovered, { result: { ready: true } }, 'correcting a transitive SDK input must wake startup');
});

test('Metro losing a source file mid-bundle is startup source drift, unlike configuration failures', () => {
  const sha = 'Error: Failed to get the SHA-1 for: /repo/packages/protocol/src/usage/usageCostFacts.ts.';
  assert.equal(isDevStartupSourceDrift({ code: 1, message: sha }, 'expo'), true);
  assert.equal(isDevStartupSourceDrift({ code: 1, message: sha, sourceDrift: false }, 'expo'), false,
    'an owner that compared input bytes can reject heuristic source-drift classification');
  assert.equal(isDevStartupSourceDrift({ code: 1, message: 'Error: listen EADDRINUSE' }, 'expo'), false);
  const exhausted = Object.assign(new Error('[workspace-build] inputs changed while building @happier-dev/plugin-sdk; retained the last coherent output; rerun the phase'), { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: true });
  assert.equal(isDevStartupSourceDrift(exhausted, 'server'), false);
  const missingDeclaredExport = Object.assign(new Error('/bin/yarn failed (code=1, sig=null)\n\nChild output:\n[stderr]\nError: Staged TypeScript package build is missing declared package export files:\n- ./src/voice/modelPacks/artifactBindingV1.ts'), { code: 'EEXIT', exitCode: 1 });
  assert.equal(isDevStartupSourceDrift(missingDeclaredExport, 'server'), true);
  assert.equal(isDevStartupSourceDrift(missingDeclaredExport, 'expo'), true);
});

test('startup preparation survives a source build failure and retries only after affected inputs change', { timeout: 10_000 }, async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-startup-source-drift-' });
  const source = fixture.path('input.mjs');
  const unrelated = fixture.path('unrelated.mjs');
  await fs.writeFile(source, 'export const value = ;');
  await fs.writeFile(unrelated, 'export const unrelated = 1;');
  const abort = new AbortController();
  t.after(() => abort.abort());
  let reportFailure;
  const failureReported = new Promise((resolve) => { reportFailure = resolve; });
  let attempts = 0;
  let settled = false;
  const startup = prepareDevComponent({
    enabled: true,
    target: 'expo',
    descriptors: [{ id: 'expo:inputs', target: 'expo', paths: [source] }],
    debounceMs: 5,
    signal: abort.signal,
    logger: { log() {}, warn() {}, error() { reportFailure(); } },
    async prepare() {
      attempts += 1;
      try {
        await run(process.execPath, ['--check', source], { captureFailureDiagnostic: true, stdio: 'ignore' });
      } catch (cause) {
        // The real Expo preflight preserves source-build failures under this envelope.
        throw Object.assign(new Error('UI preflight failed', { cause }), {
          code: 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED',
        });
      }
      if (attempts === 2) await fs.writeFile(source, 'export const value = 2;');
      return { ready: true };
    },
  });
  const completion = startup.then((result) => { settled = true; return result; });
  await Promise.race([failureReported, completion]);
  assert.equal(settled, false, 'a broken source build must leave startup pending');
  await fs.writeFile(unrelated, 'export const unrelated = 2;');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 1, 'unrelated edits must not retry the failed component');
  await fs.writeFile(source, 'export const value = 1;');
  assert.deepEqual(await completion, { ready: true });
  assert.equal(attempts, 2, 'a successful startup must not run twice when its inputs advance');

  const environmentErrors = [
    new BuildInputDriftError('producer exhausted its trailing rebuild', { trailingPassExhausted: true }),
    Object.assign(new Error('port occupied'), { code: 'EADDRINUSE' }),
    Object.assign(new Error('dependency installation failed'), { code: 'EEXIT' }),
    Object.assign(new Error('preflight failed', { cause: new Error('Invalid installFreshnessInputs') }), {
      code: 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED',
    }),
    Object.assign(new Error('preflight failed', { cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }) }), {
      code: 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED',
    }),
  ];
  for (const environmentError of environmentErrors) {
    await assert.rejects(prepareDevComponent({
      enabled: true, target: 'expo', descriptors: [{ id: 'expo:inputs', target: 'expo', paths: [source] }],
      logger: { log() {}, warn() {}, error() {} },
      prepare: async () => { throw environmentError; },
    }), (error) => error === environmentError);
  }
  const sourceFailure = Object.assign(new Error('input.ts(1,1): error TS2307: Cannot find module'), { code: 'EEXIT' });
  await assert.rejects(prepareDevComponent({
    prepare: async () => { throw sourceFailure; },
  }), (error) => error === sourceFailure, 'without watch mode, source failures remain fatal');
  const cancelled = new AbortController();
  let reportWaiting;
  const waiting = new Promise((resolve) => { reportWaiting = resolve; });
  const pending = prepareDevComponent({
    enabled: true, target: 'server', descriptors: [{ id: 'server:inputs', target: 'server', paths: [source] }],
    signal: cancelled.signal,
    logger: { log() {}, warn() {}, error() { reportWaiting(); } },
    prepare: async () => { throw sourceFailure; },
  });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await waiting;
  cancelled.abort();
  await rejection;
});

for (const retryFails of [false, true]) {
test(`failed captured source gets one immediate lifecycle retry, retry failure=${retryFails}`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-captured-failure-retry-' });
  const source = fixture.path('input.mjs');
  const capture = fixture.path('captured.mjs');
  await fs.writeFile(source, 'export const value = ;');
  let attempts = 0;
  let selected = 0;
  const coordinator = startDevReloadCoordinator({ observeChanges: false,
    descriptors: [{ id: 'daemon:inputs', target: 'daemon', paths: [source] }],
    executors: [{ target: 'daemon',
      async build() {
        attempts++;
        // The real producer captures first. Its input moves before the
        // captured bytes fail in the real compiler, without another event.
        await fs.copyFile(source, capture);
        if (attempts === 1 || (retryFails && attempts === 2)) {
          await fs.writeFile(source, retryFails && attempts === 1
            ? 'export const replacement = ;' : 'export const value = true;');
        }
        await run(process.execPath, ['--check', capture], { captureFailureDiagnostic: true, stdio: 'ignore' });
      },
      async restart() { selected++; },
    }],
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => coordinator.close());
  await coordinator.requestReload('daemon');
  assert.equal(attempts, 2, 'an input already corrected during capture earns exactly one immediate retry');
  assert.equal(selected, retryFails ? 0 : 1, 'failed captured bytes must never activate');
  if (retryFails) {
    await fs.writeFile(source, 'export const value = "next-edit";');
    await coordinator.requestReload('daemon');
    assert.equal(attempts, 3, 'after the bounded retry fails the next edit still recovers');
    assert.equal(selected, 1);
  }
});
}

for (const changedInput of ['source', 'auxiliary']) {
test(`terminal failed capture preserves a mid-build ${changedInput} edit for the next observation`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-terminal-capture-baseline-' });
  const source = fixture.path('input.mjs');
  const auxiliary = fixture.path('auxiliary.mjs');
  const capture = fixture.path('captured.mjs');
  const auxiliaryCapture = fixture.path('captured-auxiliary.mjs');
  await fs.writeFile(source, 'export const value = ;');
  await fs.writeFile(auxiliary, changedInput === 'auxiliary' ? 'export const value = ;' : 'export const value = "A";');
  let watcher;
  let attempts = 0;
  let selected = 0;
  const coordinator = startDevReloadCoordinator({
    descriptors: [
      { id: 'daemon:source', target: 'daemon', paths: [source] },
      { id: 'daemon:auxiliary', target: 'daemon', paths: [auxiliary], invalidatesGeneration: false },
    ],
    executors: [{ target: 'daemon',
      async build() {
        attempts++;
        await fs.copyFile(source, capture);
        await fs.copyFile(auxiliary, auxiliaryCapture);
        if (attempts === 1) {
          await fs.writeFile(source, changedInput === 'source' ? 'export const replacement = ;' : 'export const value = "A";');
        } else if (attempts === 2) {
          await fs.writeFile(changedInput === 'source' ? source : auxiliary, 'export const value = "B";');
        }
        // Real compiler rejection after the edit reproduces the failed
        // capture window for both generation and auxiliary inputs.
        await run(process.execPath, ['--check', capture], { captureFailureDiagnostic: true, stdio: 'ignore' });
        await run(process.execPath, ['--check', auxiliaryCapture], { captureFailureDiagnostic: true, stdio: 'ignore' });
      },
      async restart() { selected++; },
    }],
    logger: { log() {}, warn() {}, error() {} },
  }, { watchDebouncedImpl(options) { watcher = options; return { close() {} }; } });
  t.after(() => coordinator.close());
  await coordinator.requestReload('daemon');
  assert.equal(attempts, 2, 'the immediate retry episode remains bounded');
  assert.equal(selected, 0, 'neither failed capture may activate');
  await watcher.onChange({ eventType: 'poll', filename: null });
  assert.equal(attempts, 3, 'an edit already on disk when the retry failed must remain eligible');
  assert.equal(selected, 1);
  await watcher.onChange({ eventType: 'poll', filename: null });
  await watcher.onChange({ eventType: 'change', filename: changedInput === 'source' ? source : auxiliary });
  assert.equal(attempts, 3, 'unchanged observations must not re-arm another attempt');
});
}

test('reload coordinator watches and samples only inputs with an active consumer', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dev-reload-active-inputs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverSource = join(root, 'server.ts');
  const daemonSource = join(root, 'daemon.ts');
  await fs.writeFile(serverSource, 'export const server = 1;');
  await fs.writeFile(daemonSource, 'export const daemon = 1;');
  let watcherOptions;
  const coordinator = startDevReloadCoordinator({
    descriptors: [
      { id: 'server:app', target: 'server', paths: [serverSource] },
      { id: 'daemon:cli', target: 'daemon', paths: [daemonSource] },
    ],
    executors: [executor('server', [])],
  }, {
    watchDebouncedImpl(options) {
      watcherOptions = options;
      return { close() {} };
    },
  });
  t.after(() => coordinator.close());
  assert.deepEqual(watcherOptions.paths, [serverSource]);
  const before = await watcherOptions.readSignature();
  await fs.writeFile(daemonSource, 'export const daemon = 2;');
  assert.equal(await watcherOptions.readSignature(), before);
  await fs.writeFile(serverSource, 'export const server = 2;');
  watcherOptions.onObservation({ eventType: 'change', filename: 'server.ts', watchPath: serverSource });
  assert.notEqual(await watcherOptions.readSignature(), before);
});

test('overlapping reload consumers share one filesystem sweep and observe subsequent source edits', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dev-reload-shared-sweep-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps/cli');
  const serverDir = join(root, 'apps/server');
  const packageDir = join(root, 'packages/protocol');
  await fs.mkdir(join(cliDir, 'src'), { recursive: true });
  await fs.mkdir(join(serverDir, 'sources'), { recursive: true });
  await fs.mkdir(join(packageDir, 'src'), { recursive: true });
  await fs.writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/protocol'],
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  }));
  await fs.writeFile(join(serverDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/server', dependencies: { '@happier-dev/protocol': '0.0.0' },
  }));
  await fs.writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol' }));
  const source = join(packageDir, 'src/runtime.ts');
  await fs.writeFile(source, 'export const value = 1;');
  const originalLstat = fs.lstat;
  let sourceStats = 0;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (args[0] === source) sourceStats += 1;
    return originalLstat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let watcherOptions;
  const reloads = [];
  const coordinator = startDevReloadCoordinator({
    descriptors: [
      ...createHappyCliReloadDescriptors({ cliDir }),
      ...await createDevServerReloadDescriptors({ serverDir }),
    ],
    executors: [executor('server', reloads), executor('daemon', reloads)],
    logger: { log() {}, warn() {}, error() {} },
  }, {
    watchDebouncedImpl(options) {
      watcherOptions = options;
      return { close() {} };
    },
  });
  t.after(() => coordinator.close());
  await watcherOptions.readSignature();
  assert.equal(sourceStats, 1, 'one consumed source must require one stat per sample, regardless of consumer count');
  sourceStats = 0;
  const before = await watcherOptions.readSignature();
  assert.equal(sourceStats, 0, 'idle consumers share the event-indexed observation without another stat');
  const fingerprintBefore = await readHappyCliRuntimeInputFreshness(cliDir);
  assert.equal(sourceStats, 0, 'daemon build fingerprints consume the same observation owner');
  await fs.writeFile(source, 'export const value = 2;');
  watcherOptions.onObservation({ eventType: 'change', filename: 'runtime.ts', watchPath: join(packageDir, 'src') });
  const after = await watcherOptions.readSignature();
  const fingerprintAfter = await readHappyCliRuntimeInputFreshness(cliDir);
  assert.notEqual(after, before);
  assert.notEqual(fingerprintAfter.fingerprint, fingerprintBefore.fingerprint);
  await watcherOptions.onChange({ eventType: 'change', filename: 'runtime.ts', watchPath: join(packageDir, 'src') });
  assert.deepEqual(reloads, ['server:build:1', 'server:restart:1', 'daemon:build:1', 'daemon:restart:1']);
});

test('a pending build suspends recovery scans and catches up missed edits after activation', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-build-scan-' });
  const source = fixture.path('source.ts');
  await fs.writeFile(source, 'export const value = 1;');
  await fs.utimes(source, 1, 1);
  const admittedSourceStat = await fs.lstat(source, { bigint: true });
  const originalLstat = fs.lstat;
  let sourceStats = 0;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (args[0] === source) sourceStats += 1;
    return originalLstat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let poll;
  let releaseBuild;
  let markBuildStarted;
  const buildStarted = new Promise((resolve) => { markBuildStarted = resolve; });
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const builds = [];
  const activations = [];
  const coordinator = startDevReloadCoordinator({
    descriptors: [{ id: 'server:source', target: 'server', paths: [source] }],
    executors: [{
      target: 'server',
      async build(context) {
        builds.push(context.generation);
        if (context.generation === 1) {
          markBuildStarted();
          await buildBlocked;
        }
      },
      restart(context) { activations.push(context.generation); },
    }],
    pollIntervalMs: 10_000,
    debounceMs: 0,
    logger: { log() {}, warn() {}, error() {} },
  }, {
    watchDebouncedImpl(options) {
      return watchDebounced({
        ...options,
        // Clock and native notification are system boundaries. Signatures,
        // drift classification and activation all use the real owner.
        watchImpl: () => ({ close() {} }),
        setIntervalImpl(callback) { poll = callback; return { unref() {} }; },
        clearIntervalImpl() {},
      });
    },
  });
  t.after(async () => { releaseBuild(); await coordinator.close(); });
  const preparing = coordinator.requestReload('server');
  await buildStarted;
  sourceStats = 0;
  await poll();
  await poll();
  assert.equal(sourceStats, 0, 'admission/build waits must not traverse source on recovery ticks');
  // Deliberately omit the native event: completion must apply the prepared
  // generation and still discover the edit for the trailing build.
  await fs.writeFile(source, 'export const value = 2;');
  // Recovery checks known metadata. Establish an observable same-size edit
  // without assuming two awaited writes cross the filesystem's timestamp tick.
  await fs.utimes(source, 2, 2);
  const editedSourceStat = await fs.lstat(source, { bigint: true });
  assert.equal(editedSourceStat.size, admittedSourceStat.size);
  assert.notEqual(editedSourceStat.mtimeNs, admittedSourceStat.mtimeNs);
  releaseBuild();
  await preparing;
  assert.deepEqual(builds, [1, 2]);
  assert.deepEqual(activations, [1, 2]);
  sourceStats = 0;
  await poll();
  assert.equal(sourceStats, 1, 'idle missed-event recovery resumes after the build');
});

test('native queue loss in an ignored event burst recovers a missed source edit without periodic recrawl',
  { skip: process.platform !== 'linux', timeout: 60_000 }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-source-overflow-', registerCleanup: false });
    let coordinator;
    t.after(async () => {
      await coordinator?.close();
      await fixture.cleanup();
    });
    const source = fixture.path('source.ts');
    const noise = [fixture.path('a.test.ts'), fixture.path('b.test.ts')];
    await fs.writeFile(source, 'export const value = 1;');
    for (const path of noise) await fs.writeFile(path, '0');
    let ready;
    const recovered = new Promise(resolve => { ready = resolve; });
    let activated = 0;
    let sourceEvents = 0;
    let nativeEvents = 0;
    let lastNativeEventAt = null;
    let maxNativeEventGapMs = 0;
    let nativeBurstEvents = 0;
    let maxNativeBurstEvents = 0;
    let queueSize = null;
    let burstWriteMs = null;
    let recoveryWarnings = 0;
    const failures = [];
    coordinator = startDevReloadCoordinator({
      descriptors: [{ id: 'server:source', target: 'server', paths: [fixture.root] }],
      executors: [{ target: 'server', build() {}, restart() { if (++activated === 2) ready(); } }],
      debounceMs: 20, pollIntervalMs: 0,
      logger: { log() {}, warn() { recoveryWarnings++; }, error(message) { failures.push(String(message)); } },
    }, { watchDebouncedImpl(options) {
      return watchDebounced({ ...options,
        // Count events that the reload policy ignores at the OS boundary.
        // Production avoids watching these leaves; an overflow from another
        // watched input has the same raw-queue loss semantics.
        watchImpl: (path, _options, callback) => watch(path, { recursive: true }, (kind, filename) => {
          const observedAt = Date.now();
          if (lastNativeEventAt !== null) {
            const gap = observedAt - lastNativeEventAt;
            maxNativeEventGapMs = Math.max(maxNativeEventGapMs, gap);
            if (gap > 20) nativeBurstEvents = 0;
          }
          lastNativeEventAt = observedAt;
          nativeEvents++;
          maxNativeBurstEvents = Math.max(maxNativeBurstEvents, ++nativeBurstEvents);
          if (filename === 'source.ts') sourceEvents++;
          callback(kind, filename);
        }),
      });
    } });
    t.after(() => t.diagnostic(JSON.stringify({
      nodeVersion: process.version, queueSize, burstWriteMs, nativeEvents, sourceEvents,
      maxNativeEventGapMs, maxNativeBurstEvents, recoveryWarnings, activated, failures,
    })));
    await coordinator.requestReload('server');
    queueSize = Number(readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8'));
    // Block delivery until the real kernel queue is saturated. Alternating files
    // prevents inotify's adjacent-event coalescing; the final source event is lost.
    const burstStartedAt = Date.now();
    for (let n = 0; n < queueSize + 128; n++) writeFileSync(noise[n % 2], String(n % 10));
    writeFileSync(source, 'export const value = 2;');
    burstWriteMs = Date.now() - burstStartedAt;
    await recovered;
    assert.equal(activated, 2);
    assert.equal(sourceEvents, 0, 'the source event must actually be lost in this overflow probe');
  });

test('idle source recovery checks known metadata without recrawling directories', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-idle-source-index-' });
  await fs.writeFile(fixture.path('source.ts'), 'export const value = 1;');
  const originalReaddir = fs.readdir;
  let directoryReads = 0;
  t.mock.method(fs, 'readdir', async (...args) => { directoryReads++; return originalReaddir(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let poll;
  let watcherOptions;
  const coordinator = startDevReloadCoordinator({
    descriptors: [{ id: 'server:source', target: 'server', paths: [fixture.root] }],
    executors: [{ target: 'server', build() {}, restart() {} }],
    pollIntervalMs: 300_000,
    logger: { log() {}, warn() {}, error() {} },
  }, { watchDebouncedImpl(options) {
    watcherOptions = options;
    return watchDebounced({ ...options, watchImpl: () => ({ close() {} }),
      setIntervalImpl(callback) { poll = callback; return { unref() {} }; }, clearIntervalImpl() {} });
  } });
  t.after(() => coordinator.close());
  await watcherOptions.readSignature();
  directoryReads = 0;
  await poll();
  await poll();
  assert.equal(directoryReads, 0, 'unchanged known paths must not re-enumerate source trees');
});

function descriptor({ id, target, signature = '0' }) {
  let current = signature;
  return {
    id,
    target,
    paths: [`/tmp/${id}`],
    set(value) {
      current = value;
    },
    readSignature() {
      return current;
    },
  };
}

test('requestInitialDevRefreshes refreshes enabled server and daemon owners behind the admitted runtime', async () => {
  const requested = [];
  const pending = requestInitialDevRefreshes({
    reloadWatcher: {
      requestReload(target) {
        requested.push(target);
        return Promise.resolve();
      },
    },
    serverReloadEnabled: true,
    daemonReloadEnabled: true,
  });

  assert.deepEqual(requested, ['server', 'daemon']);
  await Promise.all(pending);
});

function deferredAsyncDescriptor({ id, target, signature = '0' }) {
  let current = signature;
  let activeReads = 0;
  let maxActiveReads = 0;
  let readCalls = 0;
  const pendingReads = [];
  return {
    id,
    target,
    paths: [`/tmp/${id}`],
    set(value) {
      current = value;
    },
    readSignatureAsync() {
      readCalls += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      return new Promise((resolve) => {
        pendingReads.push(() => {
          activeReads -= 1;
          resolve(current);
        });
      });
    },
    resolvePendingReads() {
      for (const resolveRead of pendingReads.splice(0)) resolveRead();
    },
    resetMetrics() {
      readCalls = 0;
      maxActiveReads = activeReads;
    },
    metrics() {
      return { activeReads, maxActiveReads, readCalls, pendingReads: pendingReads.length };
    },
  };
}

function executor(target, calls, overrides = {}) {
  return {
    target,
    ...(typeof overrides.setUnexpectedExitHandler === 'function' ? {
      setUnexpectedExitHandler(handler) {
        return overrides.setUnexpectedExitHandler(handler);
      },
    } : {}),
    ...(typeof overrides.publishFailureDisposition === 'function' ? {
      async publishFailureDisposition(disposition) {
        return await overrides.publishFailureDisposition(disposition);
      },
    } : {}),
    ...(typeof overrides.emitTransitionEvent === 'function' ? {
      emitTransitionEvent(event, details) {
        return overrides.emitTransitionEvent(event, details);
      },
    } : {}),
    ...(typeof overrides.recoverUnexpectedExit === 'function' ? {
      async recoverUnexpectedExit(event) {
        return await overrides.recoverUnexpectedExit(event);
      },
    } : {}),
    ...(typeof overrides.createPlan === 'function' ? {
      createPlan(context) {
        return overrides.createPlan(context);
      },
    } : {}),
    ...(typeof overrides.publishLifecycle === 'function' ? {
      async publishLifecycle(transition) {
        calls.push([target, 'lifecycle', transition]);
        return await overrides.publishLifecycle(transition);
      },
    } : {}),
    async build(context) {
      calls.push(`${target}:build:${context.cycle}`);
      return await overrides.build?.(context);
    },
    async restart(context) {
      calls.push(`${target}:restart:${context.cycle}`);
      return await overrides.restart?.(context);
    },
  };
}

async function observeComposedFilesystemThenPoll({ laterPollSignature = null } = {}) {
  const calls = [];
  const activations = [];
  const debounceTimers = [];
  let emitFilesystemEvent;
  let poll;
  let releaseFirstRestart;
  let markFirstRestartStarted;
  const firstRestartStarted = new Promise((resolve) => { markFirstRestartStarted = resolve; });
  const firstRestartBlocked = new Promise((resolve) => { releaseFirstRestart = resolve; });
  const app = descriptor({ id: 'server:app', target: 'server' });
  const coordinator = startDevReloadCoordinator({
    enabled: true,
    descriptors: [app],
    executors: [executor('server', calls, {
      async restart(context) {
        activations.push(context.generation);
        if (context.generation === 1) {
          markFirstRestartStarted();
          await firstRestartBlocked;
        }
      },
    })],
    debounceMs: 500,
    pollIntervalMs: 2000,
    logger: { log() {}, warn() {}, error() {} },
  }, {
    watchDebouncedImpl(options) {
      return watchDebounced({
        ...options,
        watchImpl: (_path, _watchOptions, handler) => {
          emitFilesystemEvent = handler;
          return { close() {} };
        },
        setIntervalImpl(callback, ms) {
          assert.equal(ms, 2000);
          poll = callback;
          return { unref() {} };
        },
        clearIntervalImpl() {},
        setTimeoutImpl(callback) {
          const timer = { callback, canceled: false };
          debounceTimers.push(timer);
          return timer;
        },
        clearTimeoutImpl(timer) {
          timer.canceled = true;
        },
      });
    },
  });
  assert.ok(coordinator);

  await new Promise((resolve) => setImmediate(resolve));
  await poll();
  app.set('1');
  emitFilesystemEvent('change', 'app.ts');
  // Deliver the due timer turn, not an implementation-selected first timer:
  // native burst quieting and reload debounce share this OS clock boundary.
  const filesystemDebounces = debounceTimers.splice(0);
  assert.ok(filesystemDebounces.some(timer => !timer.canceled));
  for (const timer of filesystemDebounces) {
    if (!timer.canceled) timer.callback();
  }
  await firstRestartStarted;

  if (laterPollSignature !== null) app.set(laterPollSignature);
  await poll();
  for (const timer of debounceTimers.splice(0)) {
    if (!timer.canceled) timer.callback();
  }
  releaseFirstRestart();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await coordinator.close();
  return activations;
}

test('filesystem admission and default poll correlation preserve exactly-once activation', async () => {
  assert.deepEqual(await observeComposedFilesystemThenPoll(), [1]);
  assert.deepEqual(await observeComposedFilesystemThenPoll({ laterPollSignature: '2' }), [1, 2]);
});

test('admits one generation-correlated source transition before preflight', async () => {
  const calls = [];
  const transitions = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      emitTransitionEvent(event, details) {
        transitions.push({ event, ...details });
      },
    })],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(transitions, [{
    event: 'source_generation_admitted',
    generation: 1,
    changedDescriptors: ['server:app'],
    targets: ['server'],
  }]);
  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:restart:1']);
});

test('marks a changed descriptor read error as inconclusive migration evidence', async () => {
  const calls = [];
  const contexts = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [executor('server', calls, {
      async restart(context) {
        contexts.push(context);
      },
    })],
    calls,
  });

  shared.set('error:permission denied');
  await onChange({ eventType: 'change', filename: 'v1.ts' });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].descriptorEvidenceConclusive, false);
  assert.deepEqual(contexts[0].changedDescriptors, ['shared:protocol']);
});

test('does not treat a stable unreadable Prisma descriptor as proof that migrations are unchanged', async () => {
  const calls = [];
  const contexts = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const prisma = descriptor({
    id: 'server:prisma',
    target: 'server',
    signature: 'error:permission denied',
  });
  const onChange = startCoordinator({
    descriptors: [shared, prisma],
    executors: [executor('server', calls, {
      async restart(context) {
        contexts.push(context);
      },
    })],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'v1.ts' });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].descriptorEvidenceConclusive, false);
  assert.deepEqual(contexts[0].changedDescriptors, ['shared:protocol']);
});

test('source transition observer failure cannot suppress the admitted generation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      emitTransitionEvent() { throw new Error('observer unavailable'); },
    })],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:restart:1']);
});

test('reload coordinator publishes planned, retry-scheduled, and build-blocked lifecycle truth', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let restartAttempts = 0;
  const serverExecutor = executor('server', calls, {
    createPlan(context) {
      return {
        mode: 'exclusiveDb',
        generation: context.generation,
        reason: 'overlap_capability_unproven',
      };
    },
    publishLifecycle() {},
    restart() {
      restartAttempts += 1;
      const error = new Error('release evidence inconclusive');
      error.reloadRetryAfterMs = 25;
      throw error;
    },
  });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [serverExecutor],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(restartAttempts, 1);
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry)), [
    ['server', 'lifecycle', {
      phase: 'planned',
      plan: { mode: 'exclusiveDb', generation: 1, reason: 'overlap_capability_unproven' },
    }],
    ['server', 'lifecycle', {
      phase: 'retry-scheduled',
      plan: { mode: 'exclusiveDb', generation: 1, reason: 'overlap_capability_unproven' },
      retryAfterMs: 25,
    }],
  ]);

  serverExecutor.build = async () => { throw new Error('preflight failed'); };
  server.set('2');
  await onChange({ eventType: 'change', filename: 'schema.prisma' });
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry)).at(-2), [
    'server',
    'lifecycle',
    { phase: 'planned', plan: { mode: 'exclusiveDb', generation: 2, reason: 'overlap_capability_unproven' } },
  ]);
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry)).at(-1), [
    'server',
    'lifecycle',
    {
      phase: 'blocked',
      plan: { mode: 'exclusiveDb', generation: 2, reason: 'overlap_capability_unproven' },
      disposition: { code: 'build_failed' },
    },
  ]);
});

test('a later daemon build failure does not block or terminalize the server refresh', async () => {
  const calls = [];
  const lifecycle = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [
      executor('server', calls, {
        createPlan(context) {
          return {
            mode: 'exclusiveDb',
            generation: context.generation,
            reason: 'server_reload',
          };
        },
        publishLifecycle(transition) {
          lifecycle.push(transition);
        },
      }),
      executor('daemon', calls, {
        build() {
          throw new Error('daemon build failed');
        },
      }),
    ],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'types.ts' });

  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned']);
  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1', 'daemon:build:1'],
  );
});

function startCoordinator({ descriptors, executors, calls, logger = { error() {} }, coordinatorBoundary = {} }) {
  let onChange = null;
  let onObservation = null;
  const watcher = startDevReloadCoordinator(
    { enabled: true, descriptors, executors, logger },
    {
      watchDebouncedImpl: ({ paths, onChange: captured, onObservation: capturedObservation, readSignature, pollIntervalMs }) => {
        calls.push(`watch:${paths.sort().join('|')}:${typeof readSignature}:${pollIntervalMs}`);
        onChange = captured;
        onObservation = capturedObservation;
        onChange.readSignature = readSignature;
        return { close() {} };
      },
      ...coordinatorBoundary,
    },
  );
  assert.ok(watcher);
  assert.equal(typeof onChange, 'function');
  onChange.observe = (event) => onObservation?.(event);
  onChange.watcher = watcher;
  return onChange;
}

test('explicit startup reconciliation rebuilds one requested target without a filesystem edit', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [executor('daemon', calls)],
    calls,
  });

  await onChange.watcher.requestReload('daemon');

  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);
});

test('reload coordinator uses asynchronous descriptor signatures for background polling', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let asyncReads = 0;
  server.readSignatureAsync = async () => {
    asyncReads += 1;
    return server.readSignature();
  };
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls)],
    calls,
  });

  const signaturePromise = onChange.readSignature();
  assert.equal(typeof signaturePromise?.then, 'function');
  assert.equal(await signaturePromise, 'server:app\u00000');
  assert.equal(asyncReads, 1, 'startup baseline and overlapping poll must share one asynchronous scan');
});

test('construction shares one signature scan between coordinator and watcher baselines', async () => {
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [executor('server', [])],
      logger: { error() {} },
    },
    {
      watchDebouncedImpl({ readSignature }) {
        watcherBaseline = readSignature();
        return { close() {} };
      },
    },
  );

  const constructionMetrics = server.metrics();
  server.resolvePendingReads();
  await watcherBaseline;
  coordinator.close();

  assert.equal(constructionMetrics.readCalls, 1);
  assert.equal(constructionMetrics.maxActiveReads, 1);
});

test('polling and filesystem classification share one in-flight signature scan', async () => {
  const calls = [];
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let onChange;
  let readSignature;
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [executor('server', calls)],
      logger: { error() {} },
    },
    {
      watchDebouncedImpl(boundary) {
        onChange = boundary.onChange;
        readSignature = boundary.readSignature;
        watcherBaseline = readSignature();
        return { close() {} };
      },
    },
  );

  server.resolvePendingReads();
  await watcherBaseline;
  await new Promise((resolve) => setImmediate(resolve));
  server.resetMetrics();
  server.set('1');

  const poll = readSignature();
  const filesystemChange = onChange({ eventType: 'change', filename: 'app.ts' });
  await new Promise((resolve) => setImmediate(resolve));
  const overlapMetrics = server.metrics();
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await Promise.all([poll, filesystemChange]);
  coordinator.close();

  assert.equal(overlapMetrics.readCalls, 1);
  assert.equal(overlapMetrics.maxActiveReads, 1);
  assert.deepEqual(calls, ['server:build:1', 'server:restart:1']);
});

test('a filesystem edit observed during the startup baseline is not absorbed by that baseline', async () => {
  const calls = [];
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let onChange;
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [executor('server', calls)],
      logger: { error() {} },
    },
    {
      watchDebouncedImpl(boundary) {
        onChange = boundary.onChange;
        watcherBaseline = boundary.readSignature();
        return { close() {} };
      },
    },
  );

  const startupEdit = onChange({
    eventType: 'change',
    filename: 'app.ts',
    signatureInitializedAtObservation: false,
  });
  server.set('1');
  server.resolvePendingReads();
  await watcherBaseline;
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await startupEdit;
  coordinator.close();

  assert.deepEqual(calls, ['server:build:1', 'server:restart:1']);
});

test('a startup-baseline event restarts only the consumer that owns its watched path', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [daemon, server],
    executors: [
      executor('daemon', calls),
      executor('server', calls),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({
    eventType: 'change',
    filename: 'index.ts',
    watchPath: '/tmp/daemon:cli',
    signatureInitializedAtObservation: false,
  });

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['daemon:build:1', 'daemon:restart:1'],
  );
});

test('reload coordinator establishes its startup baseline without synchronous descriptor scans', async () => {
  const calls = [];
  let syncReads = 0;
  let asyncReads = 0;
  const server = {
    id: 'server:app',
    target: 'server',
    paths: ['/tmp/server-app'],
    readSignature() {
      syncReads += 1;
      return '0';
    },
    async readSignatureAsync() {
      asyncReads += 1;
      return '0';
    },
  };

  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls)],
    calls,
  });

  assert.equal(syncReads, 0, 'coordinator construction must not block the stable proxy event loop');
  assert.ok(asyncReads >= 1);
  await onChange.readSignature();
  assert.equal(syncReads, 0);
});

test('duplicate descriptor ids use one merged-path signature observation per cycle', async () => {
  const calls = [];
  let firstReads = 0;
  let secondReads = 0;
  const first = {
    id: 'shared:protocol',
    target: 'shared',
    paths: ['/tmp/hstack-duplicate-signature-path'],
    readSignature: () => 'first',
    async readSignatureAsync() {
      firstReads += 1;
      return 'first';
    },
  };
  const second = {
    ...first,
    readSignature: () => 'second',
    async readSignatureAsync() {
      secondReads += 1;
      return 'second';
    },
  };
  const onChange = startCoordinator({
    descriptors: [first, second],
    executors: [executor('server', calls), executor('daemon', calls)],
    calls,
  });

  assert.equal(await onChange.readSignature(), 'shared:protocol\u0000');
  assert.equal(firstReads, 0);
  assert.equal(secondReads, 0);
});

test('a restart failure can request one bounded coordinator retry without another filesystem edit', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('release evidence inconclusive');
          error.reloadRetryAfterMs = 25;
          throw error;
        }
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 25);

  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'only the scheduled timer callback may start the retry');

  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'the retry must not create a second retry manager');

  await scheduled[0].callback();
  assert.equal(attempts, 2, 'success must make the completed retry callback stale');
});

test('retained server build drift cold-starts through the coordinator and retries fresh output once', async t => {
  const fixture = await createMinimalMonorepoFixture(t, { prefix: 'hstack-retained-server-reload-' });
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await fs.writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  const serverDir = fixture.path('apps/server');
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@fixture/server' }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const children = [];
  const stopChild = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  };
  t.after(async () => { for (const child of children) await stopChild(child); });
  const calls = [];
  const scheduled = [];
  const failures = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const serverProcRef = { current: null };
  let attempts = 0;
  let starts = 0;
  const serverExecutor = createDevServerReloadExecutor({
    enabled: true, stackMode: false, serverComponentName: 'happier-server-light',
    serverDir, serverPort: port, internalServerUrl: url,
    serverScript: 'dev', serverEnv: {}, children, serverProcRef,
    isShuttingDown: () => false,
  }, {
    // Compiler and process/listener adapters are the system boundaries; the
    // coordinator, server executor and retained-closure inspector remain real.
    preflightDevServerRestartImpl: async () => {
      attempts++;
      throw new BuildInputDriftError('[workspace-build] inputs changed while building @happier-dev/plugin-sdk; retained the last coherent output; rerun the phase');
    },
    pmSpawnScriptImpl: async ({ env }) => {
      starts++;
      return spawnTestProcess(process.execPath, ['-e',
        'require("node:http").createServer((req,res) => {res.setHeader("content-type","application/json");res.end(JSON.stringify({service:"happier-server",status:"ok"}));}).listen(Number(process.env.PORT),"127.0.0.1");'],
      { env: { ...process.env, ...env } });
    },
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: [children.at(-1).pid] }),
    getProcessGroupIdImpl: async pid => pid,
    logger: { log() {}, warn() {}, error() {} },
  });
  const onChange = startCoordinator({
    descriptors: [server], executors: [serverExecutor], calls,
    logger: { log() {}, warn() {}, error(message) { failures.push(message); } },
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });
  t.after(() => onChange.watcher.close());
  await onChange.watcher.requestReload('server');
  assert.equal(starts, 1, 'retained coherent output must start the absent server despite build drift');
  assert.ok(serverProcRef.current?.pid);
  assert.equal((await fetch(`${url}/health`)).status, 200, 'retained activation serves real HTTP');
  assert.equal(scheduled.length, 1, 'fresh output must get one retry without another edit');
  assert.equal(scheduled[0].delayMs, 500, 'reuse the coordinator debounce interval');
  assert.doesNotMatch(failures.join('\n'), /keeping existing services running/);

  // The service exits before the retry, which still drifts. Activation remains
  // possible, but the existing retry episode must terminate rather than spin.
  serverExecutor.setUnexpectedExitHandler(null);
  await stopChild(serverProcRef.current);
  serverProcRef.current = null;
  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(starts, 2);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal(scheduled.length, 1);
  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 2, 'exhausted drift must wait for affected inputs');

  // A drift code alone does not prove usable output. Missing declared output
  // must fail closed through the same real component inspector.
  await fs.mkdir(fixture.path('packages/sdk'), { recursive: true });
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await fs.writeFile(fixture.path('packages/sdk/package.json'), JSON.stringify({ name: '@fixture/sdk', main: './dist/index.js' }));
  await fs.writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@fixture/server', dependencies: { '@fixture/sdk': 'workspace:*' } }));
  server.set('2');
  await onChange({ eventType: 'change', filename: 'missing-output.ts' });
  assert.equal(starts, 2);
});

test('cold server preparation retries build input drift without waiting for an edit', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-cold-server-drift-' });
  const input = fixture.path('input.mjs');
  await fs.writeFile(input, 'export const value = true;');
  const abort = new AbortController();
  t.after(() => abort.abort());
  let attempts = 0;
  const result = await prepareDevComponent({
    enabled: true, target: 'server', signal: abort.signal, debounceMs: 5,
    descriptors: [{ id: 'server:inputs', target: 'server', paths: [input] }],
    logger: { log() {}, warn() {}, error() {} },
    async prepare() {
      if (++attempts === 1) throw new BuildInputDriftError('retained the last coherent output');
      return { serverStarted: true };
    },
  });
  assert.deepEqual(result, { serverStarted: true });
  assert.equal(attempts, 2);
});

test('a retryable build rejection gets one bounded retry while ordinary build failures stay terminal for an unchanged signature', async () => {
  const calls = [];
  const scheduled = [];
  const lifecycle = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [executor('daemon', calls, {
      build() {
        attempts += 1;
        const error = new Error(attempts < 3 ? 'mixed-input build rejected' : 'TypeScript compilation failed');
        if (attempts < 3) error.reloadRetryAfterMs = 25;
        throw error;
      },
      publishLifecycle(transition) {
        lifecycle.push(transition);
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  assert.equal(attempts, 1);
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [25]);
  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned', 'retry-scheduled']);

  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'duplicate notifications must not bypass the scheduled build retry');

  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'the retried build rejection must consume the existing retry episode');
  assert.deepEqual(lifecycle.map(({ phase }) => phase), [
    'planned',
    'retry-scheduled',
    'planned',
    'blocked',
  ]);

  await onChange({ eventType: 'change', filename: 'duplicate-after-retry.ts' });
  assert.equal(attempts, 2, 'the consumed retry must stay terminal until the source signature changes');

  daemon.set('2');
  await onChange({ eventType: 'change', filename: 'compile-error.ts' });
  await onChange({ eventType: 'change', filename: 'duplicate-compile-error.ts' });
  assert.equal(attempts, 3, 'an ordinary build failure must stay terminal for its source signature');
  assert.equal(scheduled.length, 1, 'an ordinary build failure must not schedule a retry');
  assert.deepEqual(lifecycle.map(({ phase }) => phase).slice(-2), ['planned', 'blocked']);
});

test('a terminal startup refresh failure consumes pathless baseline ambiguity instead of forcing every descriptor again', async () => {
  const calls = [];
  const transitions = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let daemonAttempts = 0;
  const onChange = startCoordinator({
    descriptors: [server, daemon],
    executors: [
      executor('server', calls, {
        emitTransitionEvent(event, details) {
          transitions.push({ event, ...details });
        },
      }),
      executor('daemon', calls, {
        build() {
          daemonAttempts += 1;
          throw new Error('daemon source does not compile');
        },
      }),
    ],
    calls,
  });

  await onChange({
    eventType: 'change',
    filename: null,
    signatureInitializedAtObservation: false,
  });
  assert.equal(daemonAttempts, 1);

  server.set('1');
  await onChange({ eventType: 'change', filename: 'server.ts' });

  assert.equal(daemonAttempts, 1, 'unchanged failed daemon inputs must not be rebuilt for a server-only edit');
  assert.deepEqual(transitions.map(({ changedDescriptors }) => changedDescriptors), [
    ['server:app', 'daemon:cli'],
    ['server:app'],
  ]);
  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1', 'daemon:build:1', 'server:build:2', 'server:restart:2'],
  );
});

test('the coordinator alone projects transient retry and exhausted terminal disposition', async () => {
  const calls = [];
  const scheduled = [];
  const dispositions = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        const error = new Error('replacement exited early');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
      publishFailureDisposition(disposition) {
        dispositions.push(disposition);
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0].retryScheduled, true);
  assert.equal(dispositions[0].retryAfterMs, 25);

  await scheduled[0].callback();
  assert.equal(dispositions.length, 2);
  assert.equal(dispositions[1].retryScheduled, false);
  assert.equal(dispositions[1].retryAfterMs, null);
});

test('an unexpected active-server exit re-enters the existing coordinator and close disarms it', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
    })],
    calls,
  });

  assert.equal(typeof unexpectedExitHandler, 'function');
  await unexpectedExitHandler({ code: 1, signal: null });
  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1'],
  );

  await onChange.watcher.close();
  assert.equal(unexpectedExitHandler, null);
});

test('an unexpected active-server exit restores admitted prior availability before source preparation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
      async recoverUnexpectedExit() {
        calls.push('server:recover-prior');
      },
    })],
    calls,
  });

  await unexpectedExitHandler({ code: 1, signal: null });

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string').slice(1),
    ['server:recover-prior', 'server:build:1', 'server:restart:1'],
  );
  await onChange.watcher.close();
});

test('a pathless no-delta observation does not supersede an active forced reload', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => { notifyBuildStarted = resolve; });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
      async build(context) {
        if (context.generation === 1) {
          notifyBuildStarted();
          await buildBlocked;
        }
      },
    })],
    calls,
  });

  const recovery = unexpectedExitHandler({ code: 1, signal: null });
  await buildStarted;
  assert.equal(onChange.observe({ eventType: 'change', filename: null }), true);
  releaseBuild();
  await recovery;

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1'],
  );

  await onChange.watcher.close();
});

test('a pathless changed signature queues catch-up without discarding the completed reload', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => { notifyBuildStarted = resolve; });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
      async build(context) {
        if (context.generation === 1) {
          notifyBuildStarted();
          await buildBlocked;
        }
      },
    })],
    calls,
  });

  const recovery = unexpectedExitHandler({ code: 1, signal: null });
  await buildStarted;
  server.set('1');
  assert.equal(onChange.observe({ eventType: 'change', filename: null }), true);
  releaseBuild();
  await recovery;

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1', 'server:build:2', 'server:restart:2'],
  );

  await onChange.watcher.close();
});

test('retry remains authoritative when retry lifecycle projection fails', async () => {
  const calls = [];
  const scheduled = [];
  const errors = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      publishLifecycle(transition) {
        if (transition.phase === 'retry-scheduled') throw new Error('runtime projection unavailable');
      },
      restart() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('release evidence inconclusive');
          error.reloadRetryAfterMs = 25;
          throw error;
        }
      },
    })],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(scheduled.length, 1, 'projection failure must not suppress the authoritative retry');
  assert.ok(errors.some((message) => message.includes('runtime projection unavailable')));
  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'projection failure must not let a duplicate event bypass the scheduled retry');
  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'projection failure must not duplicate the bounded retry');
});

test('the same failed signature cannot re-arm another retry after its bounded retry is consumed', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        const error = new Error('still unavailable');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  await scheduled[0].callback();

  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'unchanged failure must consume its only retry');

  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 2, 'duplicate watcher notifications must not bypass the consumed retry episode');
});

test('executor backoff defers the dirty episode instead of committing a skipped restart', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const serverExecutor = executor('server', calls, {
    restart() {
      attempts += 1;
      return attempts === 1
        ? { skipped: true, reason: 'backoff', retryAfterMs: 41 }
        : { restarted: true };
    },
  });
  serverExecutor.getBackoffRemainingMs = () => {
    throw new Error('the coordinator must not re-read a changing backoff clock');
  };
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [serverExecutor],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(attempts, 1);
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [41]);

  await scheduled[0].callback();
  assert.equal(attempts, 2);
});

test('closing the coordinator cancels a pending retry and makes its callback stale', async () => {
  const calls = [];
  const scheduled = [];
  const cleared = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        const error = new Error('temporarily unavailable');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl(timer) { cleared.push(timer); },
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  const staleTimer = scheduled[0];
  onChange.watcher.close();

  assert.deepEqual(cleared, [staleTimer]);
  await staleTimer.callback();
  assert.equal(attempts, 1);
});

test('closing the coordinator prevents an in-flight restart failure from scheduling a retry', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let rejectRestart;
  let restartStarted;
  const didStartRestart = new Promise((resolve) => {
    restartStarted = resolve;
  });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        restartStarted();
        return new Promise((_resolve, reject) => {
          rejectRestart = reject;
        });
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await didStartRestart;
  onChange.watcher.close();
  const error = new Error('release evidence inconclusive after close');
  error.reloadRetryAfterMs = 25;
  rejectRestart(error);
  await change;

  assert.equal(scheduled.length, 0, 'teardown must not create new lifecycle work');
});

test('closing the coordinator joins the in-flight cycle before resolving', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let releaseRestart;
  let markRestartStarted;
  const restartStarted = new Promise((resolve) => { markRestartStarted = resolve; });
  const restartBlocked = new Promise((resolve) => { releaseRestart = resolve; });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async restart() {
        markRestartStarted();
        await restartBlocked;
      },
    })],
    calls,
  });

  server.set('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await restartStarted;
  let closeResolved = false;
  const close = Promise.resolve(onChange.watcher.close()).then(() => { closeResolved = true; });
  await Promise.resolve();
  assert.equal(closeResolved, false, 'close must join the active restart cycle');

  releaseRestart();
  await Promise.all([change, close]);
  assert.equal(closeResolved, true);
});

test('closing during executor-facing generation revalidation revokes activation authority', async () => {
  const calls = [];
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let markExecutorRevalidationStarted;
  const executorRevalidationStarted = new Promise((resolve) => { markExecutorRevalidationStarted = resolve; });
  let revalidationResult = null;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async restart(context) {
        const revalidation = context.revalidateGeneration();
        markExecutorRevalidationStarted();
        revalidationResult = await revalidation;
        throw new Error('stop after observing executor-facing revalidation');
      },
    })],
    calls,
  });

  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.set('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  for (let read = 0; read < 2; read += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.metrics().pendingReads, 1);
    server.resolvePendingReads();
  }
  await executorRevalidationStarted;
  assert.equal(server.metrics().pendingReads, 1);

  const close = onChange.watcher.close();
  server.resolvePendingReads();
  await Promise.all([change, close]);

  assert.equal(revalidationResult, false);
});

// Brief dev-reload-starvation-1031.md task 2: "latest complete wins; never starve".
test('each completed generation applies despite multiple source edits during every preparation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const prepared = [];
  const activations = [];
  const messages = [];
  let observe;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async build(context) {
        if (context.generation <= 3) {
          for (let edit = 1; edit <= 5; edit++) {
            server.set(`${context.generation}:${edit}`);
            observe({ eventType: 'change', filename: 'app.ts', watchPath: server.paths[0] });
          }
        }
        prepared.push(context.generation);
      },
      async restart(context) {
        assert.equal(await context.revalidateGeneration(), true);
        activations.push(context.generation);
      },
    })],
    calls,
    logger: { log(message) { messages.push(message); }, error(message) { assert.fail(message); } },
  });
  observe = onChange.observe;

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(prepared, [1, 2, 3, 4]);
  assert.deepEqual(activations, prepared, 'one activation per completed preparation');
  assert.equal(messages.filter(message => message.includes('became stale')).length, 0);
  await onChange.watcher.close();
});

test('unrelated service edits preserve completed builds and coalesce only the affected trailing reload', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let observe;
  const builds = [];
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [server, daemon],
    executors: ['server', 'daemon'].map((target) => executor(target, calls, {
      async build(context) {
        builds.push(`${target}:${context.generation}`);
        if (target === 'server' && context.generation === 1) {
          for (let edit = 2; edit <= 4; edit += 1) {
            daemon.set(String(edit));
            observe({ eventType: 'change', filename: 'index.ts', watchPath: daemon.paths[0] });
          }
        }
      },
      async restart(context) {
        if (await context.revalidateGeneration()) activations.push(`${target}:${context.generation}`);
      },
    })),
    calls,
  });
  observe = onChange.observe;
  server.set('1');
  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'server.ts', watchPath: server.paths[0] });
  assert.deepEqual(builds, ['server:1', 'daemon:1', 'daemon:2']);
  assert.deepEqual(activations, ['server:1', 'daemon:1', 'daemon:2']);
});

test('CLI-only changes never prepare or invalidate the server target', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [daemon, server],
    executors: [executor('server', calls), executor('daemon', calls)],
    calls,
  });
  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts', watchPath: daemon.paths[0] });
  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);
  await onChange.watcher.close();
});

test('an explicit forced target still revokes a completed generation before activation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let onChange;
  onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async build(context) {
        if (context.generation === 1) {
          await onChange.watcher.requestReload('server');
          return { ok: true, allowSupersededActivation: true };
        }
      },
    })],
    calls,
  });
  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:build:2', 'server:restart:2']);
  await onChange.watcher.close();
});

test('the server descriptor producer preserves migration-plan safety during source capture', async t => {
  const fixture = await createMinimalMonorepoFixture(t, { prefix: 'hstack-reload-migration-safety-' });
  const serverDir = fixture.path('apps/server');
  await fs.mkdir(join(serverDir, 'src'), { recursive: true });
  await fs.mkdir(join(serverDir, 'prisma'), { recursive: true });
  const source = join(serverDir, 'src/index.ts');
  const schema = join(serverDir, 'prisma/schema.prisma');
  await fs.writeFile(source, 'export const value = 0;');
  await fs.writeFile(schema, 'model Initial {}');
  const descriptors = await createDevServerReloadDescriptors({ serverDir });
  const calls = [];
  const plans = [];
  const activations = [];
  let onChange;
  onChange = startCoordinator({
    descriptors,
    executors: [executor('server', calls, {
      createPlan(context) {
        const plan = createDevServerReloadPlan(context);
        plans.push(plan.migrationMode);
        return plan;
      },
      async build(context) {
        if (context.generation !== 1) return;
        await fs.writeFile(schema, 'model ChangedWithNewFields {}');
        onChange.observe({ eventType: 'change', filename: 'schema.prisma', watchPath: join(serverDir, 'prisma') });
      },
      restart(context) { activations.push(context.generation); },
    })],
    calls,
  });
  t.after(() => onChange.watcher.close());
  await onChange.readSignature();
  await fs.writeFile(source, 'export const value = 1;');
  await onChange({ eventType: 'change', filename: 'index.ts', watchPath: join(serverDir, 'src') });
  assert.deepEqual(plans, ['skip', 'apply']);
  assert.deepEqual(activations, [2], 'a capture with changed migration evidence cannot use the app-only plan');
});

test('shared source edits apply each completed service generation before catch-up', async () => {
  const calls = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  let observe;
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: ['server', 'daemon'].map((target) => executor(target, calls, {
      async build(context) {
        if (target === 'server' && context.generation === 1) {
          shared.set('2');
          observe({ eventType: 'change', filename: 'protocol.ts', watchPath: shared.paths[0] });
        }
      },
      async restart(context) {
        if (await context.revalidateGeneration()) activations.push(`${target}:${context.generation}`);
      },
    })),
    calls,
  });
  observe = onChange.observe;
  shared.set('1');
  await onChange({ eventType: 'change', filename: 'protocol.ts', watchPath: shared.paths[0] });
  assert.deepEqual(activations, ['server:1', 'daemon:1', 'server:2', 'daemon:2']);
});

test('an executor-owned publication update does not supersede the source generation that produced it', async () => {
  const calls = [];
  const source = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const publication = {
    ...descriptor({ id: 'daemon:cli-publication', target: 'daemon' }),
    invalidatesGeneration: false,
  };
  let observe = () => {};
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [source, publication],
    executors: [executor('daemon', calls, {
      async build(context) {
        if (context.generation !== 1) return;
        publication.set('1');
        observe({
          eventType: 'change',
          filename: '.build-manifest.json',
          watchPath: '/tmp/daemon:cli-publication',
        });
      },
      async restart(context) {
        activations.push(context.generation);
      },
    })],
    calls,
  });
  observe = onChange.observe;

  source.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(activations, [1]);
  assert.deepEqual(calls.filter((entry) => typeof entry === 'string').slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
  ]);
});

test('an external publication update remains actionable when no generation owns it', async () => {
  const calls = [];
  const publication = {
    ...descriptor({ id: 'daemon:cli-publication', target: 'daemon' }),
    invalidatesGeneration: false,
  };
  const onChange = startCoordinator({
    descriptors: [publication],
    executors: [executor('daemon', calls)],
    calls,
  });

  publication.set('1');
  await onChange({
    eventType: 'change',
    filename: '.build-manifest.json',
    watchPath: '/tmp/daemon:cli-publication',
  });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
  ]);
});

test('a completed captured daemon generation activates with or without a healthy incumbent, then replans', async t => {
  for (const scenario of [
    { name: 'crashed daemon with retained loaded identity', running: false, loaded: 'old', reason: 'daemon_not_running' },
    { name: 'never started daemon', running: false, loaded: null, reason: 'missing_state' },
    { name: 'live daemon without loaded identity', running: true, loaded: null },
    { name: 'live recorded PID with missing control state', running: true, loaded: null, reason: 'missing_state' },
  ]) await t.test(scenario.name, async () => {
    const calls = [];
    const daemon = descriptor({ id: 'daemon:app', target: 'daemon' });
    const events = [];
    let running = scenario.running;
    let controlAvailable = !scenario.reason;
    let loaded = scenario.loaded;
    let generation = 0;
    // Substitute compiler, control transport, runtime-state IO and process launch
    // boundaries; preparation, liveness policy and coordinator remain real.
    const daemonExecutor = createHappyCliReloadExecutor({
      startDaemon: true,
      runtimeStatePath: '/tmp/stack.runtime.json',
      isShuttingDown: () => false,
    }, {
      prepareDevDaemonSourceRuntimeImpl: options => prepareDevDaemonSourceRuntime(options, {
        async buildSourceRuntimeBundleImpl() {
          generation++;
          events.push(`build:${generation}`);
          if (generation === 1) daemon.set('2');
          return { identity: `gen-${generation}`, entrypoint: '/tmp/daemon.mjs', cliDir: '/tmp/cli' };
        },
        logger: { log() {} },
      }),
      pingDaemonImpl: async () => running && controlAvailable
        ? { ok: true }
        : { ok: false, reason: running ? scenario.reason : scenario.reason ?? 'daemon_not_running' },
      readStackRuntimeStateFileImpl: async () => ({
        processes: { daemonPid: 4242 },
        sourceRuntimeIdentities: { daemon: { loaded } },
      }),
      isPidAliveImpl: pid => pid === 4242 && running,
      async startLocalDaemonWithAuthImpl({ sourceRuntimeLaunchUpdate }) {
        loaded = sourceRuntimeLaunchUpdate.identity;
        running = true;
        controlAvailable = true;
        events.push(`activate:${loaded}`);
      },
      logger: { log() {}, warn() {} },
    });
    const failures = [];
    const onChange = startCoordinator({
      descriptors: [daemon], executors: [daemonExecutor], calls,
      logger: { error(message) { failures.push(String(message)); } },
    });
    t.after(() => onChange.watcher.close());

    daemon.set('1');
    await onChange({ eventType: 'change', filename: 'app.ts' });

    assert.deepEqual(failures, []);
    assert.deepEqual(events, scenario.running
      ? scenario.reason
        ? ['build:1', 'build:2']
        : ['build:1', 'activate:gen-1', 'build:2', 'activate:gen-2']
      : ['build:1', 'activate:gen-1', 'build:2', 'activate:gen-2']);
  });
});

test('an unavailable server may activate a successful superseded build before the latest generation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async build(context) {
        if (context.generation === 1) {
          server.set('2');
          return { allowSupersededActivation: true };
        }
        return undefined;
      },
      async restart(context) {
        assert.equal(context.allowSupersededActivation, context.generation === 1);
        activations.push(context.generation);
      },
    })],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [1, 2]);
});

test('a named Prisma observation during the pre-activation sampling gap revokes the app-only generation', async () => {
  for (const eventType of ['change', 'rename']) {
    const calls = [];
    const app = descriptor({ id: 'server:app', target: 'server' });
    let prismaSignature = '0';
    let hideNextPrismaSignature = false;
    const prisma = {
      id: 'server:prisma',
      target: 'server',
      invalidatesGeneration: true,
      paths: ['/tmp/server:prisma'],
      set(value) {
        prismaSignature = value;
      },
      hideNextRead() {
        hideNextPrismaSignature = true;
      },
      readSignature() {
        if (hideNextPrismaSignature) {
          hideNextPrismaSignature = false;
          return '0';
        }
        return prismaSignature;
      },
    };
    let observe = () => {};
    const activations = [];
    const onChange = startCoordinator({
      descriptors: [app, prisma],
      executors: [executor('server', calls, {
        async restart(context) {
          if (context.generation === 1) {
            assert.equal(await context.revalidateGeneration(), true);
            prisma.set('1');
            prisma.hideNextRead();
            observe({ eventType, filename: 'schema.prisma' });
          }
          if (await context.revalidateGeneration()) activations.push(context.generation);
        },
      })],
      calls,
    });
    observe = onChange.observe;

    app.set('1');
    await onChange({ eventType: 'change', filename: 'app.ts' });

    assert.deepEqual(
      activations,
      [2],
      `${eventType} must revoke the stale pre-activation generation`,
    );
  }
});

test('an ignored test-only observation does not revoke an in-flight production generation', async () => {
  const calls = [];
  const app = descriptor({ id: 'server:app', target: 'server' });
  let observe = () => {};
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [app],
    executors: [executor('server', calls, {
      async restart(context) {
        if (context.generation === 1) {
          observe({ eventType: 'change', filename: 'session.spec.ts' });
        }
        if (await context.revalidateGeneration()) activations.push(context.generation);
      },
    })],
    calls,
  });
  observe = onChange.observe;

  app.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [1]);
});

test('a handled debounce delivery cannot suppress a distinct edit during the replanned cycle', async () => {
  const calls = [];
  const app = descriptor({ id: 'server:app', target: 'server' });
  let prismaSignature = '0';
  let hideNextPrismaSignature = false;
  const prisma = {
    id: 'server:prisma',
    target: 'server',
    invalidatesGeneration: true,
    paths: ['/tmp/server:prisma'],
    set(value) {
      prismaSignature = value;
    },
    hideNextRead() {
      hideNextPrismaSignature = true;
    },
    readSignature() {
      if (hideNextPrismaSignature) {
        hideNextPrismaSignature = false;
        return String(Number(prismaSignature) - 1);
      }
      return prismaSignature;
    },
  };
  let observe = () => {};
  let deliverDebounced = () => {};
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [app, prisma],
    executors: [executor('server', calls, {
      async restart(context) {
        if (context.generation <= 2) {
          assert.equal(await context.revalidateGeneration(), true);
          prisma.set(String(context.generation));
          prisma.hideNextRead();
          observe({ eventType: 'change', filename: 'schema.prisma' });
          deliverDebounced({
            eventType: 'change',
            filename: 'schema.prisma',
            observationHandled: true,
          });
        }
        if (await context.revalidateGeneration()) activations.push(context.generation);
      },
    })],
    calls,
  });
  observe = onChange.observe;
  deliverDebounced = onChange;

  app.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [3]);
});

test('a new signature cancels the old retry and starts a fresh bounded retry episode', async () => {
  const calls = [];
  const scheduled = [];
  const cleared = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        const error = new Error('temporarily unavailable');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl(timer) { cleared.push(timer); },
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });
  const staleTimer = scheduled[0];

  server.set('2');
  await onChange({ eventType: 'change', filename: 'second.ts' });

  assert.deepEqual(cleared, [staleTimer]);
  assert.equal(scheduled.length, 2);
  await staleTimer.callback();
  assert.equal(attempts, 2, 'a canceled timer must not replay an old signature episode');
});

test('shared edits refresh server and daemon independently in restart order', async () => {
  const calls = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [executor('daemon', calls), executor('server', calls)],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'server:restart:1',
    'daemon:build:1',
    'daemon:restart:1',
  ]);
});

test('shared source edits preserve Expo while explicit Expo inputs still restart it', async () => {
  const calls = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const dependencies = descriptor({ id: 'expo:dependencies', target: 'expo' });
  const config = descriptor({ id: 'expo:metro-config', target: 'expo' });
  const onChange = startCoordinator({
    descriptors: [shared, dependencies, config],
    executors: [executor('server', calls), executor('daemon', calls), executor('expo', calls)],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  assert.deepEqual(calls.slice(1), [
    'server:build:1', 'server:restart:1',
    'daemon:build:1', 'daemon:restart:1',
  ]);

  calls.length = 0;
  dependencies.set('1');
  await onChange({ eventType: 'change', filename: 'publication.generation' });
  assert.deepEqual(calls, ['expo:build:2', 'expo:restart:2']);

  calls.length = 0;
  config.set('1');
  await onChange({ eventType: 'change', filename: 'metro.config.js' });
  assert.deepEqual(calls, ['expo:build:3', 'expo:restart:3']);
  await onChange.watcher.close();
});

test('a skipped build is not admitted for restart', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [{
      target: 'daemon',
      async build() {
        calls.push('daemon:build');
        return { skipped: true, reason: 'cli-build-mode_never' };
      },
      async restart() {
        calls.push('daemon:restart');
        return { restarted: true };
      },
    }],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), ['daemon:build']);
});

test('failed build skips restarts and later changes can retry', async () => {
  const calls = [];
  const errors = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [
      executor('server', calls, {
        build() {
          throw new Error('preflight failed');
        },
      }),
    ],
    calls,
    logger: { error(message) { errors.push(String(message)); } },
  });

  server.set('1');
  await onChange({});
  server.set('2');
  await onChange({});

  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:build:2']);
  assert.ok(errors.some((message) => message.includes('preflight failed')));
});

test('a failed shared daemon refresh does not make a completed server refresh repeat', async () => {
  const calls = [];
  let daemonBuildAttempts = 0;
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [shared, daemon],
    executors: [
      executor('server', calls),
      executor('daemon', calls, {
        build() {
          daemonBuildAttempts += 1;
          if (daemonBuildAttempts === 1) {
            throw new Error('daemon build failed');
          }
        },
      }),
    ],
    calls,
  });

  shared.set('1');
  await onChange({});
  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'server:restart:1',
    'daemon:build:1',
  ]);

  daemon.set('1');
  await onChange({});
  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'server:restart:1',
    'daemon:build:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('a failed server refresh does not block an independent daemon refresh', async () => {
  const calls = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [
      executor('server', calls, {
        build() {
          throw new Error('server build failed');
        },
      }),
      executor('daemon', calls),
    ],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'types.ts' });

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'daemon:build:1', 'daemon:restart:1'],
  );
});

test('changes during a running cycle collapse into one trailing cycle', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [daemon],
    executors: [
      executor('daemon', calls, {
        async restart(context) {
          if (context.cycle === 1) {
            daemon.set('2');
            await onChange({});
            daemon.set('3');
            await onChange({});
          }
        },
      }),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({});

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('a successful activation can request one forced trailing build without another filesystem edit', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli-publication', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [
      executor('daemon', calls, {
        build(context) {
          return context.cycle === 1 ? { requestFollowup: true } : undefined;
        },
      }),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: '.build-manifest.json' });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('a superseded generation clears its server lifecycle plan before the trailing generation is planned', async () => {
  const calls = [];
  const lifecycle = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [server],
    executors: [
      executor('server', calls, {
        createPlan(context) {
          return { mode: 'exclusiveDb', generation: context.generation };
        },
        publishLifecycle(transition) {
          lifecycle.push(transition);
        },
        async build(context) {
          if (context.cycle === 1) {
            server.set('2');
            await onChange({ eventType: 'change', filename: 'second.ts', forcedTarget: 'server' });
            return { skipped: true, reason: 'superseded-preflight' };
          }
        },
      }),
    ],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned', 'idle', 'planned']);
  assert.deepEqual(calls.filter((call) => String(call).startsWith('server:restart:')), ['server:restart:2']);
});

test('a failed idle projection does not suppress the trailing superseding generation', async () => {
  const calls = [];
  const errors = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [server],
    executors: [
      executor('server', calls, {
        publishLifecycle(transition) {
          if (transition.phase === 'idle') {
            throw new Error('runtime projection unavailable');
          }
        },
        async build(context) {
          if (context.cycle === 1) {
            server.set('2');
            await onChange({ eventType: 'change', filename: 'second.ts', forcedTarget: 'server' });
            return { skipped: true, reason: 'superseded-preflight' };
          }
        },
      }),
    ],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.filter((call) => String(call).startsWith('server:restart:')), ['server:restart:2']);
  assert.ok(errors.some((message) => message.includes('runtime projection unavailable')));
});

test('a superseded activation-capable build reaches its executor while exactly one latest generation remains pending', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [daemon],
    executors: [
      executor('daemon', calls, {
        async build(context) {
          if (context.cycle === 1) {
            daemon.set('2');
            await onChange({ eventType: 'change', filename: 'second.ts' });
            return { ok: true, allowSupersededActivation: true };
          }
          return { ok: true };
        },
        async restart(context) {
          calls.push(`generation-current:${context.generation}:${await context.revalidateGeneration()}`);
        },
      }),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'generation-current:1:true',
    'daemon:build:2',
    'daemon:restart:2',
    'generation-current:2:true',
  ]);
});
