import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { ensureDevExpoServer } from '../dev/expo_dev.mjs';
import { withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { getExpoStatePaths, writePidState } from './expo.mjs';
import { expoSpawn } from './command.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'scratch consumer did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixtureFor(t) {
  const fixture = await createTempFixture(t, {
    prefix: 'happier-dependency-metro-',
    parentDir: tmpdir(),
  });
  const { uiDir } = await ensureMinimalMonorepoLayout(fixture.root);
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
  }));
  await writeFile(fixture.path('package.json'), '{"private":true,"workspaces":["apps/*"]}\n');
  await writeFile(fixture.path('yarn.lock'), '# fixture\n');
  await mkdir(fixture.path('node_modules', '.bin'), { recursive: true });
  const patchOutput = fixture.path('node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  await mkdir(join(patchOutput, '..'), { recursive: true });
  await writeFile(patchOutput, 'export {};');
  // PM availability is an OS boundary. Keep the real readiness owner while
  // making any unexpected install/build/postinstall invocation fail loudly.
  const yarnEntrypoint = fixture.path('yarn.cjs');
  await writeFile(yarnEntrypoint,
    "if (process.argv[2] === '--version') console.log('1.22.22'); else process.exit(43);\n");
  const stackName = 'scratch-metro';
  const baseDir = fixture.path('stacks', stackName);
  const envPath = join(baseDir, 'env');
  const env = {
    ...process.env,
    npm_execpath: yarnEntrypoint,
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

test('cold dependency bootstrap imports and refreshes from source with no compiled workspace closure', async (t) => {
  const fixture = await createTempFixture(t, {
    prefix: 'happier-cold-dependency-owner-', parentDir: tmpdir(),
  });
  const sourceDir = fixture.path('apps', 'stack', 'scripts', 'utils');
  for (const source of [
    'proc/dependency_refresh.mjs', 'proc/jsonOwnerFileLock.mjs', 'proc/pids.mjs',
    'proc/workspace_package_manifests.mjs', 'proc/ui_postinstall.mjs',
    'expo/dependency_barrier.mjs', 'fs/fs.mjs', 'fs/json.mjs',
    'paths/paths.mjs', 'paths/canonical_home.mjs',
    'dev_targets/stack_paths.mjs',
  ]) {
    const target = join(sourceDir, source);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(new URL(`../${source}`, import.meta.url), target);
  }
  const installDir = fixture.path('install');
  await mkdir(join(installDir, 'node_modules'), { recursive: true });
  await writeFile(join(installDir, 'package.json'), '{"private":true}\n');
  const { withDependencyRefresh: coldRefresh } = await import(pathToFileURL(join(sourceDir, 'proc', 'dependency_refresh.mjs')).href);
  const result = await coldRefresh({ installDir, env: {
    ...process.env, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'),
  } }, async () => {});
  assert.equal(result.refreshed, true);
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
    ...process.env, HAPPIER_STACK_HOME_DIR: '', HAPPIER_STACK_STORAGE_DIR: '',
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
  await writeFile(fixture.path('yarn.lock'), '# changed\n');
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

test('managed Metro stops before dependency mutation and restarts only after readiness succeeds', async (t) => {
  const fixture = await fixtureFor(t);
  const children = [];
  let shuttingDown = false;
  t.after(async () => {
    shuttingDown = true;
    for (const child of children) await killProcessTree(child, 'SIGTERM', { graceMs: 500 });
  });
  const readerScript = fixture.path('metro-reader.cjs');
  const runsPath = fixture.path('reader-runs');
  const observationsPath = fixture.path('partial-observations');
  const dependencyPath = fixture.path('node_modules', 'patched.js');
  await writeFile(dependencyPath, 'patched');
  await writeFile(readerScript, [
    "const fs = require('node:fs');",
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
  const result = await ensureDevExpoServer({
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
  await unlink(fixture.patchOutput);
  await withDependencyRefresh({
    installDir: fixture.root, env: fixture.env,
    onDependenciesReady: async () => {
      assert.notEqual(second.exitCode ?? second.signalCode, null);
      await writeFile(fixture.patchOutput, 'export {};');
    },
  }, async () => assert.fail('a second warm repair must not reinstall'));
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
  await assert.rejects(expoSpawn({
    label: 'scratch-expo', dir: fixture.uiDir, projectDir: fixture.uiDir,
    args: ['start', '--web'], env: fixture.env, workspacePrepared: true,
    quiet: true, options: { silent: true },
  }), { code: 'HAPPIER_EXPO_DEPENDENCIES_NOT_READY' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(children.length, 3, 'failed patching must not expose the incomplete tree to a replacement');
  assert.equal(await readFile(observationsPath, 'utf8').catch(() => ''), '');
});

test('a child killed during its own admission publication still consumes the crash budget', async (t) => {
  const fixture = await fixtureFor(t);
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
      children, spawnOptions: { silent: true }, quiet: true,
      isShuttingDown: () => shuttingDown,
    });
    await waitFor(async () => children.length === 1 && children[0].signalCode !== null);
  }, publicationLock);
  await startup;
  await withJsonOwnerFileLock(async () => {
    await waitFor(async () => children.length === 2 && children[1].signalCode !== null);
  }, publicationLock);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await readFile(runsPath, 'utf8')).trim().split('\n').length, 2,
    'own spawn-admission lock must not convert a rapid crash loop into planned install transitions');
});
