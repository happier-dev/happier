import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';

async function createExpoWorkspaceFixture({ workspaceBuildFails = false } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-preflight-'));
  const uiDir = join(tmp, 'apps', 'ui');
  const fixturePackageDir = join(tmp, 'packages', 'fixture-workspace');
  const workspaceBuildMarker = join(tmp, 'workspace-preflight-ran.txt');
  const expoStartedMarker = join(tmp, 'expo-started.txt');

  await mkdir(join(tmp, 'node_modules'), { recursive: true });
  await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(tmp, 'apps', 'cli'), { recursive: true });
  await mkdir(join(tmp, 'apps', 'server'), { recursive: true });
  await mkdir(fixturePackageDir, { recursive: true });

  await writeFile(join(tmp, 'package.json'), JSON.stringify({
    private: true,
    packageManager: 'yarn@1.22.22',
    workspaces: ['apps/*', 'packages/*'],
  }) + '\n', 'utf-8');
  await writeFile(join(tmp, 'yarn.lock'), '# fixture lockfile\n', 'utf-8');
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: 'happier-ui',
    private: true,
    dependencies: { '@happier-dev/fixture-workspace': '0.0.0' },
  }) + '\n', 'utf-8');
  await writeFile(join(tmp, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'happier-cli', private: true }) + '\n', 'utf-8');
  await writeFile(join(tmp, 'apps', 'server', 'package.json'), JSON.stringify({ name: 'happier-server', private: true }) + '\n', 'utf-8');
  await writeFile(join(fixturePackageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/fixture-workspace',
    private: true,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    scripts: { build: 'node build.mjs' },
  }) + '\n', 'utf-8');
  await writeFile(join(fixturePackageDir, 'build.mjs'), workspaceBuildFails
    ? "throw new Error('fixture workspace build failed');\n"
    : [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const outDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;",
        "mkdirSync(outDir, { recursive: true });",
        "writeFileSync(join(outDir, 'index.js'), 'export {};\\n', 'utf-8');",
        "writeFileSync(join(outDir, 'index.d.ts'), 'export {};\\n', 'utf-8');",
        `writeFileSync(${JSON.stringify(workspaceBuildMarker)}, 'ok\\n', 'utf-8');`,
      ].join('\n') + '\n', 'utf-8');

  const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
  await writeFile(expoBin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(expoStartedMarker)}, 'started\\n', 'utf-8');`,
    `console.log(fs.existsSync(${JSON.stringify(workspaceBuildMarker)}) ? 'preflight-ok' : 'preflight-missing');`,
    'setTimeout(() => process.exit(0), 100);',
  ].join('\n') + '\n', 'utf-8');
  await chmod(expoBin, 0o755);

  return { tmp, uiDir, workspaceBuildMarker, expoStartedMarker };
}

function createExpoBaseEnv(tmp) {
  return {
    ...process.env,
    HAPPIER_STACK_VERBOSE: '1',
    HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(tmp, 'cache'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  };
}

async function startFixtureExpo({ tmp, uiDir, spawnOptions = undefined, ...overrides }) {
  return await ensureDevExpoServer({
    startUi: true,
    startMobile: false,
    uiDir,
    autostart: { baseDir: tmp },
    baseEnv: createExpoBaseEnv(tmp),
    apiServerUrl: 'http://127.0.0.1:1',
    restart: true,
    stackMode: false,
    runtimeStatePath: null,
    stackName: 'test',
    envPath: '',
    children: [],
    spawnOptions,
    quiet: true,
    ...overrides,
  });
}

test('ensureDevExpoServer still starts Expo when the UI workspace build preflight fails', async () => {
  const fixture = await createExpoWorkspaceFixture({ workspaceBuildFails: true });
  try {
    const result = await startFixtureExpo(fixture);

    const deadlineMs = Date.now() + 3000;
    while (Date.now() < deadlineMs && !(await readFile(fixture.expoStartedMarker, 'utf-8').catch(() => ''))) {
      await delay(50);
    }

    assert.equal(result.skipped, false);
    assert.equal(await readFile(fixture.expoStartedMarker, 'utf-8'), 'started\n');
  } finally {
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer keeps the stack available when the canonical app preflight fails', async () => {
  const fixture = await createExpoWorkspaceFixture();
  try {
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    await writeFile(
      join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'),
      "export async function ensureUiWorkspacePackagesBuilt() { throw new Error('projection mismatch'); }\n",
      'utf-8',
    );

    const result = await startFixtureExpo(fixture);
    const deadlineMs = Date.now() + 3000;
    while (Date.now() < deadlineMs && !(await readFile(fixture.expoStartedMarker, 'utf-8').catch(() => ''))) {
      await delay(50);
    }

    assert.equal(result.skipped, false);
    assert.equal(await readFile(fixture.expoStartedMarker, 'utf-8'), 'started\n');
  } finally {
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer starts from last-green outputs while the canonical UI refresh continues', async () => {
  const fixture = await createExpoWorkspaceFixture();
  let startPromise;
  try {
    const releasePath = join(fixture.tmp, 'release-canonical-preflight');
    const completedPath = join(fixture.tmp, 'canonical-preflight-completed');
    const sharedDepsStampPath = join(
      fixture.tmp,
      '.project',
      'tmp',
      'cli-source-dev-shared-deps-sync.json',
    );
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    await mkdir(join(fixture.tmp, '.project', 'tmp'), { recursive: true });
    await writeFile(
      sharedDepsStampPath,
      '{"version":5,"entries":{"closure":{}}}\n',
      'utf8',
    );
    await writeFile(
      join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'),
      [
        "import { existsSync } from 'node:fs';",
        "import { writeFile } from 'node:fs/promises';",
        "import { setTimeout as delay } from 'node:timers/promises';",
        `export function hasUsableUiWorkspaceLastGreen() { return true; }`,
        'export async function ensureUiWorkspacePackagesBuilt() {',
        `  while (!existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
        `  await writeFile(${JSON.stringify(completedPath)}, 'ready\\n');`,
        '}',
      ].join('\n') + '\n',
      'utf8',
    );

    startPromise = startFixtureExpo(fixture);
    const startupOutcome = await Promise.race([
      startPromise.then(() => 'started'),
      delay(5_000).then(() => 'blocked'),
    ]);

    assert.equal(startupOutcome, 'started');
    const expoDeadlineMs = Date.now() + 3000;
    while (
      Date.now() < expoDeadlineMs
      && !(await readFile(fixture.expoStartedMarker, 'utf8').catch(() => ''))
    ) {
      await delay(20);
    }
    assert.equal(await readFile(fixture.expoStartedMarker, 'utf8'), 'started\n');
    await assert.rejects(() => readFile(completedPath, 'utf8'), /ENOENT/);

    await writeFile(releasePath, 'go\n', 'utf8');
    const deadlineMs = Date.now() + 3000;
    while (Date.now() < deadlineMs && !(await readFile(completedPath, 'utf8').catch(() => ''))) {
      await delay(20);
    }
    assert.equal(await readFile(completedPath, 'utf8'), 'ready\n');
  } finally {
    await writeFile(join(fixture.tmp, 'release-canonical-preflight'), 'go\n', 'utf8').catch(() => {});
    await startPromise?.catch(() => {});
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer starts from available workspace outputs while the first canonical UI publication continues', async () => {
  const fixture = await createExpoWorkspaceFixture();
  let startPromise;
  try {
    const releasePath = join(fixture.tmp, 'release-first-canonical-preflight');
    const completedPath = join(fixture.tmp, 'first-canonical-preflight-completed');
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    await writeFile(
      join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'),
      [
        "import { existsSync } from 'node:fs';",
        "import { writeFile } from 'node:fs/promises';",
        "import { setTimeout as delay } from 'node:timers/promises';",
        'export function hasUsableUiWorkspaceLastGreen() { return false; }',
        'export async function ensureUiWorkspacePackagesBuilt() {',
        `  while (!existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
        `  await writeFile(${JSON.stringify(completedPath)}, 'ready\\n');`,
        '}',
      ].join('\n') + '\n',
      'utf8',
    );

    startPromise = startFixtureExpo(fixture);
    const startupOutcome = await Promise.race([
      startPromise.then(() => 'started'),
      delay(2_000).then(() => 'blocked'),
    ]);

    assert.equal(startupOutcome, 'started');
    const expoDeadlineMs = Date.now() + 3000;
    while (
      Date.now() < expoDeadlineMs
      && !(await readFile(fixture.expoStartedMarker, 'utf8').catch(() => ''))
    ) {
      await delay(20);
    }
    assert.equal(await readFile(fixture.expoStartedMarker, 'utf8'), 'started\n');
    await assert.rejects(() => readFile(completedPath, 'utf8'), /ENOENT/);

    await writeFile(releasePath, 'go\n', 'utf8');
    const deadlineMs = Date.now() + 3000;
    while (Date.now() < deadlineMs && !(await readFile(completedPath, 'utf8').catch(() => ''))) {
      await delay(20);
    }
    assert.equal(await readFile(completedPath, 'utf8'), 'ready\n');
  } finally {
    await writeFile(join(fixture.tmp, 'release-first-canonical-preflight'), 'go\n', 'utf8').catch(() => {});
    await startPromise?.catch(() => {});
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer runs canonical workspace preparation outside the persistent Metro tmpdir', async () => {
  const fixture = await createExpoWorkspaceFixture();
  let resolvePrepared;
  const prepared = new Promise((resolve) => { resolvePrepared = resolve; });
  try {
    const persistentTmpDir = join(fixture.tmp, 'persistent-metro-tmp');
    await startFixtureExpo({
      ...fixture,
      prepareExpoWorkspace: async ({ env }) => {
        resolvePrepared({ tmpdir: env.TMPDIR, tmp: env.TMP, temp: env.TEMP });
      },
      hasUsableWorkspaceLastGreen: async () => true,
      baseEnv: {
        ...createExpoBaseEnv(fixture.tmp),
        TMPDIR: persistentTmpDir,
        TMP: persistentTmpDir,
        TEMP: persistentTmpDir,
      },
    });

    const observed = await prepared;
    assert.notEqual(observed.tmpdir, persistentTmpDir);
    assert.equal(observed.tmp, observed.tmpdir);
    assert.equal(observed.temp, observed.tmpdir);
  } finally {
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer adopts an existing Expo process while canonical refresh continues', async () => {
  const fixture = await createExpoWorkspaceFixture();
  let existingExpo = null;
  let startPromise;
  try {
    const canonicalMarker = join(fixture.tmp, 'canonical-ui-preflight-ran.txt');
    const releasePath = join(fixture.tmp, 'release-existing-expo-preflight');
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    await writeFile(
      join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'),
      [
        "import { existsSync } from 'node:fs';",
        "import { writeFile } from 'node:fs/promises';",
        "import { setTimeout as delay } from 'node:timers/promises';",
        'export async function ensureUiWorkspacePackagesBuilt() {',
        `  while (!existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
        `  await writeFile(${JSON.stringify(canonicalMarker)}, 'ready\\n');`,
        '}',
      ].join('\n') + '\n',
      'utf-8',
    );
    const paths = getExpoStatePaths({
      baseDir: fixture.tmp,
      kind: 'expo-dev',
      projectDir: fixture.uiDir,
      stateFileName: 'expo.state.json',
    });
    existingExpo = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        __UNSAFE_EXPO_HOME_DIRECTORY: paths.expoHomeDir,
      },
    });
    existingExpo.unref();
    await writePidState(paths.statePath, {
      pid: existingExpo.pid,
      uiDir: fixture.uiDir,
      projectDir: fixture.uiDir,
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://127.0.0.1:1',
      metroConfigFingerprint: 'missing',
    });

    startPromise = ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir: fixture.uiDir,
      autostart: { baseDir: fixture.tmp },
      baseEnv: createExpoBaseEnv(fixture.tmp),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'test',
      envPath: '',
      children: [],
      quiet: true,
    });

    const startupOutcome = await Promise.race([
      startPromise.then(() => 'started'),
      delay(2_000).then(() => 'blocked'),
    ]);
    assert.equal(startupOutcome, 'started');
    const result = await startPromise;
    assert.equal(result.reason, 'already_running');
    await assert.rejects(() => readFile(canonicalMarker, 'utf-8'), /ENOENT/);

    await writeFile(releasePath, 'go\n', 'utf8');
    const deadlineMs = Date.now() + 3000;
    while (Date.now() < deadlineMs && !(await readFile(canonicalMarker, 'utf-8').catch(() => ''))) {
      await delay(20);
    }
    assert.equal(await readFile(canonicalMarker, 'utf-8'), 'ready\n');
  } finally {
    await writeFile(join(fixture.tmp, 'release-existing-expo-preflight'), 'go\n', 'utf8').catch(() => {});
    await startPromise?.catch(() => {});
    try {
      if (existingExpo?.pid) process.kill(-existingExpo.pid, 'SIGKILL');
    } catch {}
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});
