import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDevExpoServer, resolveMetroConfigFingerprint } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { inspectDependencyRefresh, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { beginPendingSourceStart } from '../../runtime/shared/pending_source_start.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';

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
    packageManager: 'pnpm@12.14.0',
  }) + '\n', 'utf-8');
  await writeFile(join(tmp, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    'importers:',
    '  .: {}',
    '  apps/cli: {}',
    '  apps/server: {}',
    '  apps/ui:',
    '    dependencies:',
    "      '@happier-dev/fixture-workspace':",
    '        specifier: workspace:*',
    '        version: link:../../packages/fixture-workspace',
    '  packages/fixture-workspace: {}',
    '',
  ].join('\n'), 'utf-8');
  await writeFile(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  await writeFile(join(tmp, 'retained-inventory.js'), 'export const inventory = [];\n', 'utf-8');
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: 'happier-ui',
    private: true,
    dependencies: { '@happier-dev/fixture-workspace': 'workspace:*' },
  }) + '\n', 'utf-8');
  await writeFile(join(tmp, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'happier-cli', private: true }) + '\n', 'utf-8');
  await writeFile(join(tmp, 'apps', 'server', 'package.json'), JSON.stringify({ name: 'happier-server', private: true }) + '\n', 'utf-8');
  await writeFile(join(fixturePackageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/fixture-workspace',
    version: '0.0.0',
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

  // The external installer produces metadata after the real dependency owner
  // clears an unadmitted worker tree, then that owner publishes admission.
  await withDependencyRefresh({
    installDir: tmp, componentDir: uiDir,
    env: { ...createExpoBaseEnv(tmp), HAPPIER_STACK_SKIP_REFRESH_DEPS: '0' },
  }, async () => {
    await mkdir(join(tmp, 'node_modules'), { recursive: true });
    await writeFile(join(tmp, 'node_modules', '.modules.yaml'),
      'packageManager: pnpm@12.14.0\nlayoutVersion: 5\nnodeLinker: hoisted\n');
  });

  return { tmp, uiDir, workspaceBuildMarker, expoStartedMarker };
}

function createExpoBaseEnv(tmp) {
  return {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: tmp }),
    HAPPIER_STACK_VERBOSE: '1',
    HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(tmp, 'cache'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  };
}

async function startFixtureExpo({ tmp, uiDir, spawnOptions = undefined, ...overrides }) {
  const result = await ensureDevExpoServer({
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
  // The fixture Expo exits on its own; settle it before removing its executable.
  await result.proc?.completion;
  return result;
}

test('ensureDevExpoServer rejects a fresh workspace build failure before starting Expo', async t => {
  const fixture = await createExpoWorkspaceFixture({ workspaceBuildFails: true });
  try {
    const { env } = await installWorkspaceAdmissionProcessFixture(t, fixture.tmp, { env: createExpoBaseEnv(fixture.tmp) });
    await assert.rejects(startFixtureExpo({ ...fixture, baseEnv: env }), /fixture workspace build failed/);
    await assert.rejects(readFile(fixture.expoStartedMarker), { code: 'ENOENT' });
  } finally {
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

for (const ownStart of [false, true]) test(`Expo dependency refresh proceeds during a pending start (ownStart=${ownStart})`, { timeout: 20_000 }, async t => {
  const fixture = await createExpoWorkspaceFixture();
  let pending;
  let startup;
  try {
    const { env: admittedEnv } = await installWorkspaceAdmissionProcessFixture(t, fixture.tmp, { env: createExpoBaseEnv(fixture.tmp) });
    const installMarker = join(fixture.tmp, 'dependency-install-ran');
    // Replace only the external package-manager executable. The real Expo
    // startup, PM adapter, refresh admission, pending lifecycle and spawn run.
    const { binDir } = writeFakeBin({ root: fixture.tmp, name: 'pnpm', content: [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "if (process.argv[2] === '--version') { console.log('12.14.0'); process.exit(0); }",
      "if (process.argv[2] === 'run' && process.argv.includes('build')) {",
      "  const result = require('node:child_process').spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit', env: process.env });",
      '  process.exit(result.status ?? 1);',
      '}',
      "if (process.argv[2] !== 'install') process.exit(97);",
      "fs.mkdirSync('node_modules', { recursive: true });",
      "fs.writeFileSync('node_modules/.modules.yaml', 'packageManager: pnpm@12.14.0\\nlayoutVersion: 5\\nnodeLinker: hoisted\\n');",
      `fs.writeFileSync(${JSON.stringify(installMarker)}, 'installed\\n');`,
    ].join('\n') + '\n' });
    const callerBaseDir = join(fixture.tmp, 'stacks', 'expo-owner');
    await mkdir(callerBaseDir, { recursive: true });
    await writeFile(join(callerBaseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${fixture.tmp}\n`);
    const stackBaseDir = ownStart ? callerBaseDir : join(fixture.tmp, 'stacks', 'qa-starting');
    await mkdir(stackBaseDir, { recursive: true });
    await writeFile(join(stackBaseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${fixture.tmp}\n`);
    const env = { ...admittedEnv,
      PATH: [binDir, admittedEnv.PATH].join(delimiter),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '0',
      HAPPIER_STACK_REPO_DIR: fixture.tmp,
      HAPPIER_STACK_ENV_FILE: join(callerBaseDir, 'env'),
      HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    };
    pending = await beginPendingSourceStart({ stackBaseDir, repoDir: fixture.tmp, env });
    await writeFile(join(fixture.tmp, 'pnpm-lock.yaml'), '# changed dependency inputs\n');
    const admissionPath = join(fixture.tmp, 'node_modules', '.happier-stack-dependencies-ready');
    const before = await readFile(admissionPath, 'utf8');
    startup = startFixtureExpo({ ...fixture, baseEnv: env });
    const result = await startup;
    assert.equal(result.ok, true);
    assert.notEqual(await readFile(admissionPath, 'utf8'), before);
    assert.equal(await readFile(installMarker, 'utf8'), 'installed\n');
    assert.equal(await readFile(fixture.expoStartedMarker, 'utf8'), 'started\n');
    assert.equal((await inspectDependencyRefresh({ installDir: fixture.tmp, componentDir: fixture.uiDir, env })).required, false);
  } finally {
    await pending?.dispose();
    await startup?.catch(() => {});
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

for (const repaired of [true, false]) test(`Expo workspace file gaps recover beyond the nominal retry count or respect shutdown (repaired=${repaired})`, async () => {
  const fixture = await createExpoWorkspaceFixture();
  let shuttingDown = false;
  try {
    const attemptsPath = join(fixture.tmp, 'preparation-attempts');
    const compilerPath = join(fixture.tmp, 'node_modules/@typescript/native/bin/tsc');
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    // Installed preparation tooling is the filesystem boundary; the actual
    // Expo lifecycle, preflight adapter, retry policy and spawn remain real.
    await writeFile(join(fixture.uiDir, 'scripts/ensureWorkspacePackagesBuilt.mjs'), [
      "import { appendFile, lstat } from 'node:fs/promises';",
      'export async function ensureUiWorkspacePackagesBuilt() {',
      `  await appendFile(${JSON.stringify(attemptsPath)}, 'attempt\\n');`,
      `  await lstat(${JSON.stringify(compilerPath)});`,
      '}',
    ].join('\n'));
    const start = () => startFixtureExpo({ ...fixture, isShuttingDown: () => shuttingDown, baseEnv: {
      ...createExpoBaseEnv(fixture.tmp),
      HAPPIER_STACK_EXPO_SUPERVISE_RESTARTS: '1',
      HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '2',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
      HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
    } });
    const startup = start();
    void startup.catch(() => {});
    const deadline = Date.now() + 5_000;
    while ((await readFile(attemptsPath, 'utf8').catch(() => '')).trim().split('\n').length < 3
      && Date.now() < deadline) await delay(10);
    assert.ok((await readFile(attemptsPath, 'utf8')).trim().split('\n').length >= 3);
    await assert.rejects(readFile(fixture.expoStartedMarker), { code: 'ENOENT' });
    if (repaired) {
      await mkdir(join(fixture.tmp, 'node_modules/@typescript/native/bin'), { recursive: true });
      await writeFile(compilerPath, 'compiler recovered');
      await startup;
      shuttingDown = true;
      assert.equal(await readFile(fixture.expoStartedMarker, 'utf8'), 'started\n');
    } else {
      shuttingDown = true;
      await assert.rejects(startup, error => error.code === 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED'
        && error.cause?.code === 'ENOENT');
      await assert.rejects(readFile(fixture.expoStartedMarker), { code: 'ENOENT' });
    }
  } finally {
    shuttingDown = true;
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer surfaces a fresh canonical app preflight failure before starting Expo', async () => {
  const fixture = await createExpoWorkspaceFixture();
  try {
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    await writeFile(
      join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'),
      "export async function ensureUiWorkspacePackagesBuilt() { throw new Error('projection mismatch'); }\n",
      'utf-8',
    );

    await assert.rejects(startFixtureExpo(fixture), { code: 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED' });
    await assert.rejects(readFile(fixture.expoStartedMarker), { code: 'ENOENT' });
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
        `export function resolveUiWorkspaceStartupOutputs() { return [${JSON.stringify(join(fixture.tmp, 'retained-inventory.js'))}]; }`,
        'export async function ensureUiWorkspacePackagesBuilt() {',
        `  while (existsSync(${JSON.stringify(fixture.tmp)}) && !existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
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

test('Expo recovers from retained output while canonical source preparation is pending', async () => {
  const fixture = await createExpoWorkspaceFixture();
  const children = [];
  let preparations = [];
  let result;
  let shuttingDown = false;
  const releasePath = join(fixture.tmp, 'release-recovery-preflight');
  const completedPath = join(fixture.tmp, 'recovery-preflight-completed');
  const runCountPath = join(fixture.tmp, 'expo-runs');
  const recoveryInputPath = join(fixture.uiDir, 'scripts', 'recovery-input.js');
  try {
    await mkdir(join(fixture.uiDir, 'scripts'), { recursive: true });
    await writeFile(recoveryInputPath, 'export const repaired = false;\n');
    await writeFile(join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'), [
      "import { existsSync } from 'node:fs';",
      "import { writeFile } from 'node:fs/promises';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      `export function resolveUiWorkspaceStartupOutputs() { return [${JSON.stringify(join(fixture.tmp, 'retained-inventory.js'))}]; }`,
      'export const preparations = [];',
      'export function ensureUiWorkspacePackagesBuilt() {',
      '  const preparation = (async () => {',
      `    while (existsSync(${JSON.stringify(fixture.tmp)}) && !existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
      `    await writeFile(${JSON.stringify(completedPath)}, 'ready\\n');`,
      '  })();',
      '  preparations.push(preparation);',
      '  return preparation;',
      '}',
    ].join('\n') + '\n');
    ({ preparations } = await import(pathToFileURL(join(fixture.uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs')).href));
    const expoBin = join(fixture.uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const path = ${JSON.stringify(runCountPath)};`,
      "const count = Number(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : 0) + 1;",
      'fs.writeFileSync(path, String(count));',
      'if (count <= 2) process.exit(0);',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    await chmod(expoBin, 0o755);
    result = await ensureDevExpoServer({
      startUi: true, uiDir: fixture.uiDir, autostart: { baseDir: fixture.tmp },
      baseEnv: { ...createExpoBaseEnv(fixture.tmp),
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_DEV_RELOAD_POLL_MS: '50' },
      apiServerUrl: 'http://127.0.0.1:1', stackMode: true,
      // Runtime metadata has its own composed supervision coverage. This
      // availability fixture does not need its asynchronous exit writer.
      stackName: 'qa-retained-expo-recovery', runtimeStatePath: null,
      envPath: '', children, isShuttingDown: () => shuttingDown,
      spawnOptions: { silent: true }, quiet: true,
    });
    const exitDeadline = Date.now() + 5000;
    while (children[1]?.exitCode !== 0 && Date.now() < exitDeadline) await delay(20);
    assert.equal(children[1]?.exitCode, 0);
    // Recovery must not need an edit to wake a suppressed source observer.
    const recoveryDeadline = Date.now() + 5000;
    while (children.length < 3 && Date.now() < recoveryDeadline) await delay(20);
    assert.equal(children.length, 3, 'retained Metro output must restore availability before source preparation finishes');
    assert.equal(children[2].exitCode, null);
    await assert.rejects(readFile(completedPath), { code: 'ENOENT' });
  } finally {
    shuttingDown = true;
    await writeFile(releasePath, 'go\n').catch(() => {});
    await result?.close?.();
    await Promise.all(preparations);
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.completion));
    await rm(fixture.tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer waits for the first canonical UI publication before starting Expo', async () => {
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
        `export function resolveUiWorkspaceStartupOutputs() { return [${JSON.stringify(join(fixture.tmp, 'absent-inventory.js'))}]; }`,
        'export async function ensureUiWorkspacePackagesBuilt() {',
        `  while (existsSync(${JSON.stringify(fixture.tmp)}) && !existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
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

    assert.equal(startupOutcome, 'blocked');
    await assert.rejects(readFile(fixture.expoStartedMarker), { code: 'ENOENT' });
    await assert.rejects(() => readFile(completedPath, 'utf8'), /ENOENT/);

    await writeFile(releasePath, 'go\n', 'utf8');
    await startPromise;
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
        `export function resolveUiWorkspaceStartupOutputs() { return [${JSON.stringify(join(fixture.tmp, 'retained-inventory.js'))}]; }`,
        'export async function ensureUiWorkspacePackagesBuilt() {',
        `  while (existsSync(${JSON.stringify(fixture.tmp)}) && !existsSync(${JSON.stringify(releasePath)})) await delay(10);`,
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
      metroConfigFingerprint: await resolveMetroConfigFingerprint({ projectDir: fixture.uiDir, env: createExpoBaseEnv(fixture.tmp) }),
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
