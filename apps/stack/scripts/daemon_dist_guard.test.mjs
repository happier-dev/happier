import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';

import {
  DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS,
  applyDaemonDistClosureRuntimeEnv,
  assertFinalSourceDaemonDistAdmission,
  checkDaemonState,
  checkDaemonStatePingAware,
  ensureHappierCliDistExists,
  getDaemonEnv,
  isGuardedSourceCliDistEntrypoint,
  resolveDaemonDistRestartReason,
  resolveGuardedLocalCliDistSelection,
  resolveGuardedLocalCliDistEntrypoint,
  startLocalDaemonWithAuth,
  stopLocalDaemon,
} from './daemon.mjs';
import { writeCliDistBuildManifest } from './utils/cli/cliDistIntegrity.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import {
  prepareStubHappierCliDependencies,
  writeStubCliDistBuildManifest,
  writeStubHappierCliFiles,
} from './testkit/core/stub_happier_cli_files.mjs';
import { buildStubHappierServerSetSource } from './testkit/core/stub_happier_cli_server_set.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { resolveCliDistBuildLockPath, withCliDistBuildLock } from './utils/proc/cliDistBuildLock.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { installWorkspaceAdmissionProcessFixture } from './testkit/core/native_admission_fixture.mjs';
import { spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import { installSourceAdmissionFixture, installSourcePreparationInputs } from './testkit/core/source_runtime_fixture.mjs';
import { isAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

const CLI_DIST_BUILD_MANIFEST_MODULE_URL = new URL(
  '../../../packages/cli-common/cliDistBuildManifest.cjs',
  import.meta.url,
).href;

function runGit(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function buildDaemonDistGuardEnv(overrides = {}) {
  return {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_CLI_ROOT_DIR: '',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_RUNTIME_MODE: '',
    HAPPIER_STACK_RUNTIME_DIR: '',
    HAPPIER_STACK_NODE: '',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '',
    HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '',
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '',
    HAPPIER_STACK_TUI: '0',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    ...overrides,
  };
}

test('daemon state and retirement reject a real unreaped departed process', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-daemon-departed-owner-'));
  const releasePath = join(root, 'release-parent');
  const childScript = "process.stdin.once('data', () => process.exit(0)); process.stdout.write('ready');";
  // Block this fixture parent's event loop, as in the JSON-lock owner test.
  // Its real child exits while libuv cannot reap it, preserving kernel state Z.
  const parentScript = `import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['pipe','pipe','inherit']});
    child.stdout.once('data',()=>{process.stdout.write(String(child.pid)+'\\n');child.stdin.end('exit');
      const state=new Int32Array(new SharedArrayBuffer(4));
      while(!existsSync(process.argv[1]))Atomics.wait(state,0,0,10);
    });`;
  const parent = spawnTestProcess(process.execPath, ['--input-type=module', '-e', parentScript, releasePath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise(resolve => parent.once('close', resolve));
  try {
    const [chunk] = await once(parent.stdout, 'data', { signal: t.signal });
    const pid = Number(String(chunk).trim());
    assert.ok(pid > 1);
    while (true) {
      t.signal.throwIfAborted();
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.doesNotThrow(() => process.kill(pid, 0), 'the OS still exposes the departed process');
    assert.equal(isAlive(pid), false, 'the fixture observer accepts a departed process before its parent reaps it');
    await waitForProcessExit({ pid, timeoutMs: 2_000, intervalMs: 25, label: 'departed child fixture' });
    const env = buildDaemonDistGuardEnv({ HAPPIER_SERVER_URL: '', HAPPIER_WEBAPP_URL: '' });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir: root, env });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: parent.pid }));
    assert.deepEqual(checkDaemonState(root, { env }), { status: 'running', pid: parent.pid }, 'a live owner still remains running');
    await writeFile(statePath, JSON.stringify({ pid }));
    assert.deepEqual(checkDaemonState(root, { env }), { status: 'stale_state', pid });
    await stopLocalDaemon({ cliBin: join(root, 'missing-cli'), cliHomeDir: root, internalServerUrl: '', env });
    assert.equal(parent.exitCode, null, 'retirement must preserve the unrelated live fixture parent');
  } finally {
    await writeFile(releasePath, 'release');
    assert.equal(await exited, 0, 'the fixture parent resumes and reaps its child');
    await rm(root, { recursive: true, force: true });
  }
});

test('missing local CLI dist recovery forwards the authoritative environment to the build owner', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-recovery-env-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await writeFile(cliBin, 'process.exit(0);\n', 'utf-8');
  const env = buildDaemonDistGuardEnv({
    HAPPIER_STACK_CLI_ROOT_DIR: '',
    HAPPIER_TEST_REBUILD_ENV: 'forwarded',
  });

  const result = await ensureHappierCliDistExists(
    { cliBin, env },
    {
      ensureCliBuiltImpl: async (ownerDir, options) => {
        assert.equal(ownerDir, cliDir);
        assert.equal(options.env, env);
        await mkdir(join(cliDir, 'dist'), { recursive: true });
        await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
        writeStubCliDistBuildManifest(cliDir);
        return { built: true, current: true, reason: 'rebuilt' };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.built, true);
});

test('applyDaemonDistClosureRuntimeEnv marks an admitted runtime-backed daemon and clears the policy for source mode', () => {
  const env = {};
  const base = {
    runtimeStatePath: '/tmp/happier/stack.runtime.json',
    distEntrypoint: '/tmp/happier/runtime/builds/snap-1/cli/package-dist/index.mjs',
    distClosureFingerprint: 'abc123def4567890',
  };

  applyDaemonDistClosureRuntimeEnv(env, { ...base, runtimeBacked: true });
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, '1');
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, base.distEntrypoint);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, base.distClosureFingerprint);

  applyDaemonDistClosureRuntimeEnv(env, base);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
});

async function writeHappyMonorepoMarkers(rootDir) {
  await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

async function prepareCurrentSourceCliFixture(rootDir, cliDir) {
  const dependencyEnv = await prepareStubHappierCliDependencies(rootDir, {
    cliDir,
    env: buildDaemonDistGuardEnv({
      HAPPIER_STACK_REPO_DIR: rootDir,
      HAPPIER_STACK_HOME_DIR: join(rootDir, '.stack-home'),
      HAPPIER_STACK_STORAGE_DIR: join(rootDir, '.stacks'),
      HAPPIER_DEV_TARGET_EXECUTION: '1',
    }),
  });
  writeStubCliDistBuildManifest(cliDir);
  return dependencyEnv;
}

async function prepareSelectedSourceCliFixture(rootDir, cliDir, stackBaseDir, { observeLazyGeneration = false } = {}) {
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ ...manifest, name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  const mutableSource = await readFile(join(cliDir, 'dist/index.mjs'), 'utf8');
  const source = observeLazyGeneration ? mutableSource.replace(
    'await startFakePingAwareDaemon(state).ready;',
    "event((await import('./startGeneration')).generation); await startFakePingAwareDaemon(state).ready;",
  ) : mutableSource;
  await writeFile(join(cliDir, 'src/index.ts'), source);
  await writeFile(join(cliDir, 'src/startGeneration.ts'), "export const generation = 'immutable-a';");
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(rootDir, 'daemon');
  const dependencyEnv = await prepareStubHappierCliDependencies(rootDir, { cliDir, env: buildDaemonDistGuardEnv({
    HAPPIER_STACK_REPO_DIR: rootDir, HAPPIER_STACK_HOME_DIR: join(rootDir, '.stack-home'),
    HAPPIER_DEV_TARGET_EXECUTION: '1',
  }) });
  const nativeRoot = join(rootDir, 'source-admission');
  await mkdir(nativeRoot);
  const native = await installSourceAdmissionFixture(nativeRoot);
  return await native.build({ repoDir: rootDir, stackBaseDir, component: 'daemon', env: { ...native.env, ...dependencyEnv },
    waitForSourceChanges: false });
}

test('source admission exposes an unchanged runnable prior dist as degraded when the current build fails', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-build-failed-fallback-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
  const fingerprint = String(JSON.parse(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8')).fingerprint);
  const probes = [];

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        throw new Error('yarn failed (code=47)');
      },
      probeCliDistRuntimeImportImpl: async (entrypoint, options) => {
        probes.push({ entrypoint, timeoutMs: options.timeoutMs });
      },
    },
  );

  assert.deepEqual(probes, [{ entrypoint: distEntrypoint, timeoutMs: 120_000 }]);
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, fingerprint);
  assert.match(result.reason, /build_failed:yarn failed \(code=47\)/);
});

test('source admission recognizes a restored release backup as the unchanged prior dist after build failure', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-build-failed-release-backup-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distDir = join(cliDir, 'dist');
  const distEntrypoint = join(distDir, 'index.mjs');
  const releaseBackupDir = join(cliDir, '.dist.hstack-backup');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
  const fingerprint = String(
    JSON.parse(await readFile(join(distDir, '.build-manifest.json'), 'utf-8')).fingerprint,
  );
  await rename(distDir, releaseBackupDir);
  const probes = [];

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        await rename(releaseBackupDir, distDir);
        throw new Error(
          '[cli-build-inputs] runtime inputs changed while this build was running; refusing to finalize a mixed CLI closure',
        );
      },
      probeCliDistRuntimeImportImpl: async (entrypoint) => {
        probes.push(entrypoint);
      },
    },
  );

  assert.deepEqual(probes, [distEntrypoint]);
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, fingerprint);
  assert.equal(result.fallbackRejectedReason, null);
  assert.match(result.reason, /build_failed:.*runtime inputs changed while this build was running/i);
});

test('source admission exposes a valid prior dist as degraded when builds are disabled', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-build-disabled-fallback-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
  const fingerprint = String(JSON.parse(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8')).fingerprint);
  const probes = [];

  const result = await ensureHappierCliDistExists(
    {
      cliBin,
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_CLI_BUILD: '0',
      },
    },
    {
      ensureCliBuiltImpl: async () => ({ built: false, current: false, reason: 'disabled' }),
      probeCliDistRuntimeImportImpl: async (entrypoint) => probes.push(entrypoint),
    },
  );

  assert.deepEqual(probes, [distEntrypoint]);
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, fingerprint);
});

test('source admission exposes a successful but superseded build as degraded without rebuilding or reproving it', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-superseded-build-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
  const fingerprint = String(JSON.parse(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8')).fingerprint);

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => ({
        built: true,
        current: false,
        reason: 'inputs_changed_during_build',
      }),
      probeCliDistRuntimeImportImpl: async () => {
        throw new Error('the successful build owner already proved the published artifact');
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.equal(result.built, true);
  assert.equal(result.degraded, true);
  assert.equal(result.fallbackFingerprint, fingerprint);
  assert.equal(result.reason, 'inputs_changed_during_build');
});

test('source daemon admission reuses an exact watcher-admitted dist without a second always build', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-exact-admission-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  const written = writeStubCliDistBuildManifest(cliDir);
  const admittedFingerprint = written.manifest.fingerprint;
  let builds = 0;

  const admitted = await ensureHappierCliDistExists(
    {
      cliBin,
      admittedDistClosureFingerprint: admittedFingerprint,
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_CLI_BUILD_MODE: 'always',
      },
    },
    {
      ensureCliBuiltImpl: async () => {
        builds += 1;
        return { built: true, current: true, reason: 'changed' };
      },
    },
  );

  assert.equal(builds, 0);
  assert.equal(admitted.ok, true);
  assert.equal(admitted.current, true);
  assert.equal(admitted.built, false);
  assert.equal(admitted.reason, 'admitted-dist-closure');

  const mismatched = await ensureHappierCliDistExists(
    {
      cliBin,
      admittedDistClosureFingerprint: '1111111111111111',
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_CLI_BUILD_MODE: 'always',
      },
    },
    {
      ensureCliBuiltImpl: async () => {
        builds += 1;
        return { built: true, current: true, reason: 'changed' };
      },
    },
  );

  assert.equal(builds, 0);
  assert.equal(mismatched.ok, true);
  assert.equal(mismatched.current, false);
  assert.match(mismatched.reason, /^admitted_dist_mismatch:/);
});

test('source daemon releases publication before immutable start-to-stable verification', { skip: process.platform !== 'linux' }, async (t) => {
  withPatchedProcessEnv(t, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined });
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-source-daemon-start-publication-lease-'));
  const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
  const cliDir = join(tmp, 'apps', 'cli');
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
  const eventsPath = join(tmp, 'daemon-events.log');
  const cliBin = await writeDelayedStopStubHappyCli({
    cliDir,
    profileDelayMs: 500,
    stopDelayMs: 750,
    startDelayMs: 500,
  });
  const lockPath = resolveCliDistBuildLockPath(tmp);
  let startPromise = null;
  let profilePublisherPromise = null;
  let stopPublisherPromise = null;
  let startPublisherPromise = null;
  let daemonEnv = null;
  let shouldShutdown = false;
  try {
    await writeHappyMonorepoMarkers(tmp);
    const dependencyEnv = await prepareCurrentSourceCliFixture(tmp, cliDir);
    const immutable = await prepareSelectedSourceCliFixture(tmp, cliDir, dirname(runtimeStatePath), { observeLazyGeneration: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const admittedDistClosureFingerprint = String(
      JSON.parse(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8')).fingerprint,
    );
    assert.equal(
      isGuardedSourceCliDistEntrypoint({
        cliBin,
        distEntrypoint: join(cliDir, 'dist', 'index.mjs'),
        activeCliDir: cliDir,
      }),
      true,
      'fixture must exercise the source-dist admission path',
    );
    const env = buildDaemonDistGuardEnv({
      ...dependencyEnv,
      HAPPIER_STACK_REPO_DIR: tmp,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      HAPPIER_STACK_TUI: '0',
      HAPPIER_STACK_CLI_ROOT_DIR: '',
      HAPPIER_STACK_RUNTIME_MODE: '',
      HAPPIER_STACK_RUNTIME_DIR: '',
      HAPPIER_STACK_NODE: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '',
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '',
      HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '',
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '10000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '300',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1',
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
    });
    daemonEnv = env;

    startPromise = startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => shouldShutdown,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
      admittedDistClosureFingerprint,
    });

    const waitForEvent = async (event) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const events = await readFile(eventsPath, 'utf-8').catch(() => '');
        if (events.split(/\n+/).includes(event)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const events = await readFile(eventsPath, 'utf-8').catch(() => '');
      assert.fail(`expected daemon ${event} command to begin; observed events=${JSON.stringify(events)}`);
    };

    await waitForEvent('profile');
    let profilePublisherEntered = false;
    profilePublisherPromise = withCliDistBuildLock(
      async () => { profilePublisherEntered = true; },
      { lockPath, timeoutMs: 10_000, pollIntervalMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(profilePublisherEntered, true,
      'immutable profile reconciliation does not retain workspace publication custody');
    await waitForEvent('stop');
    await profilePublisherPromise;
    assert.equal(profilePublisherEntered, true, 'profile completion releases publication before daemon stop');
    let stopPublisherEntered = false;
    stopPublisherPromise = withCliDistBuildLock(
      async () => {
        stopPublisherEntered = true;
      },
      { lockPath, timeoutMs: 10_000, pollIntervalMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(
      stopPublisherEntered,
      true,
      'a delayed daemon stop must not retain the source publication lease',
    );
    await stopPublisherPromise;

    await waitForEvent('start');
    let startPublisherEntered = false;
    startPublisherPromise = withCliDistBuildLock(
      async () => {
        startPublisherEntered = true;
        await rename(join(cliDir, 'dist'), join(cliDir, 'retired-dist'));
        await writeFile(join(cliDir, 'src/startGeneration.ts'), "export const generation = 'moving-b';");
      },
      { lockPath, timeoutMs: 10_000, pollIntervalMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(
      startPublisherEntered,
      true,
      'an immutable starting daemon must not retain workspace publication custody',
    );
    await startPromise;
    await startPublisherPromise;
    assert.equal(startPublisherEntered, true, 'the publisher proceeds while immutable daemon startup remains pending');
    const selected = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(selected.sourceRuntimeLaunch.entrypoint, immutable.entrypoint);
    assert.equal(selected.sourceRuntimeLaunch.env.PATH?.split(':')[0], join(cliHomeDir, 'source-runtime', 'bin'),
      'the retained launch must deliver source command exposure to a self-restarting incumbent');
    assert.equal(selected.sourceRuntimeIdentities.daemon.loaded, immutable.identity);
    assert.match(await readFile(eventsPath, 'utf8'), /(^|\n)immutable-a(\n|$)/,
      'a lazy startup import consumes the prepared generation after mutable publication retires');
  } finally {
    shouldShutdown = true;
    await startPromise?.catch(() => {});
    await profilePublisherPromise?.catch(() => {});
    await stopPublisherPromise?.catch(() => {});
    await startPublisherPromise?.catch(() => {});
    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env: daemonEnv ?? buildDaemonDistGuardEnv({
        HAPPIER_STACK_REPO_DIR: tmp,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      }),
      stackName: 'dev',
    }).catch(() => {});
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ordinary source restart retains the prepared immutable launch across mutable publication', { skip: process.platform !== 'linux' }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-source-daemon-final-publication-'));
  const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
  const cliDir = join(tmp, 'apps', 'cli');
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
  const eventsPath = join(tmp, 'daemon-events.log');
  const closureEnvMarker = join(tmp, 'daemon-closure-env.json');
  const cliBin = await writeDelayedStopStubHappyCli({
    cliDir,
    stopDelayMs: 500,
  });
  await tagStubCliDistLaunchSource({ cliDir, tag: 'ordinary-source-restart' });
  let daemonEnv = null;
  let restart = null;
  let restartError = null;
  try {
    await writeHappyMonorepoMarkers(tmp);
    const dependencyEnv = await prepareCurrentSourceCliFixture(tmp, cliDir);
    const immutable = await prepareSelectedSourceCliFixture(tmp, cliDir, dirname(runtimeStatePath));
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const initialFingerprint = String(
      JSON.parse(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8')).fingerprint,
    );
    const env = buildDaemonDistGuardEnv({
      ...dependencyEnv,
      HAPPIER_STACK_REPO_DIR: tmp,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      HAPPIER_STACK_TUI: '0',
      HAPPIER_STACK_CLI_ROOT_DIR: '',
      HAPPIER_STACK_RUNTIME_MODE: '',
      HAPPIER_STACK_RUNTIME_DIR: '',
      HAPPIER_STACK_NODE: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '',
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '',
      HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '',
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '3000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1',
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
      HAPPIER_TEST_DAEMON_CLOSURE_ENV_MARKER: closureEnvMarker,
    });
    daemonEnv = env;

    restart = startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    restart.catch((error) => {
      restartError = error;
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const events = await readFile(eventsPath, 'utf-8').catch(() => '');
      if (events.split(/\n+/).includes('stop')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(
      await readFile(eventsPath, 'utf-8').catch(() => ''),
      /(^|\n)stop(\n|$)/,
      `the test must mutate the source publication while the old daemon is stopping${
        restartError ? `; restart failed: ${String(restartError?.stack ?? restartError)}` : ''
      }`,
    );

    const mutableEntrypoint = join(cliDir, 'dist', 'index.mjs');
    await writeFile(
      mutableEntrypoint,
      `${await readFile(mutableEntrypoint, 'utf-8')}\n// publication B\n`,
      'utf-8',
    );
    const finalFingerprint = writeStubCliDistBuildManifest(cliDir).manifest.fingerprint;
    assert.notEqual(finalFingerprint, initialFingerprint);

    await restart;
    assert.deepEqual(JSON.parse(await readFile(closureEnvMarker, 'utf-8')), {
      distEntrypoint: null,
      subprocessEntrypoint: immutable.entrypoint,
      preferTsx: '0',
      fingerprint: null,
    });
  } finally {
    await restart?.catch(() => {});
    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env: daemonEnv ?? buildDaemonDistGuardEnv({
        HAPPIER_STACK_REPO_DIR: tmp,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      }),
      stackName: 'dev',
    }).catch(() => {});
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('source daemon final admission fences only an explicitly admitted fingerprint', () => {
  const admittedFingerprint = '1111111111111111';
  const finalFingerprint = '2222222222222222';

  assert.equal(
    assertFinalSourceDaemonDistAdmission({
      admittedDistClosureFingerprint: '   ',
      finalFingerprint,
    }),
    finalFingerprint,
  );

  let spawned = false;
  assert.throws(
    () => {
      assertFinalSourceDaemonDistAdmission({
        admittedDistClosureFingerprint: admittedFingerprint,
        finalFingerprint,
      });
      spawned = true;
    },
    (error) => error?.code === 'ECLIDISTSTALECOLDSTART',
  );
  assert.equal(spawned, false, 'a changed final manifest must be rejected before daemon spawn');
});

test('source admission uses a successful current build without entering degraded fallback', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-current-build-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
  let probes = 0;

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'changed' }),
      probeCliDistRuntimeImportImpl: async () => {
        probes += 1;
      },
    },
  );

  assert.equal(probes, 0);
  assert.equal(result.ok, true);
  assert.equal(result.current, true);
  assert.notEqual(result.degraded, true);
  assert.equal(result.reason, 'changed');
});

test('source admission never promotes a different dist identity from a failed rebuild', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-build-failed-mutated-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
  let probes = 0;

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        await writeFile(distEntrypoint, 'export const changed = true;\n', 'utf-8');
        writeStubCliDistBuildManifest(cliDir);
        throw new Error('build failed after publication attempt');
      },
      probeCliDistRuntimeImportImpl: async () => {
        probes += 1;
      },
    },
  );

  assert.equal(probes, 0);
  assert.notEqual(result.degraded, true);
  assert.equal(result.current, false);
  assert.equal(result.fallbackRejectedReason, 'dist_identity_changed_during_failed_build');
  assert.match(result.reason, /build_failed/);
});

test('source admission rejects a manifest-valid prior dist when its runtime import probe fails', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-build-failed-probe-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(cliBin), { recursive: true });
  await mkdir(dirname(distEntrypoint), { recursive: true });
  await writeFile(distEntrypoint, 'export {};\n', 'utf-8');
  writeStubCliDistBuildManifest(cliDir);

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        throw new Error('yarn failed (code=47)');
      },
      probeCliDistRuntimeImportImpl: async () => {
        throw new Error('runtime import failed');
      },
    },
  );

  assert.notEqual(result.degraded, true);
  assert.match(result.fallbackRejectedReason, /^runtime_probe_failed:runtime import failed/);
});

test('source admission still fails when the current build fails without a usable prior dist', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happy-cli-build-failed-missing-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps', 'cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  await mkdir(dirname(cliBin), { recursive: true });

  const result = await ensureHappierCliDistExists(
    { cliBin, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } },
    {
      ensureCliBuiltImpl: async () => {
        throw new Error('yarn failed (code=47)');
      },
      probeCliDistRuntimeImportImpl: async () => {
        throw new Error('must not probe a missing dist');
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.current, false);
  assert.notEqual(result.degraded, true);
  assert.equal(result.fallbackRejectedReason, 'no_usable_prior_dist');
  assert.match(result.reason, /build_failed:yarn failed \(code=47\)/);
});

test('daemon dist guard does not restart when only dist mtimes are newer than daemon startup', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-daemon-dist-mtime-only-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      daemon: {
        distClosureFingerprint: '1111111111111111',
      },
    }) + '\n',
    'utf-8',
  );

  assert.equal(
    resolveDaemonDistRestartReason({
      distEntrypoint: join(tmp, 'apps', 'cli', 'dist', 'index.mjs'),
      distClosure: {
        ok: true,
        fingerprint: '1111111111111111',
        maxMtimeMs: Date.now() + 60_000,
      },
      runtimeStatePath,
      cliHomeDir: tmp,
      env: buildDaemonDistGuardEnv(),
    }),
    null,
  );
});

test('runtime-backed daemon adoption requires a valid authenticated fingerprint equal to the admitted closure', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-runtime-daemon-authenticated-fingerprint-'));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const admittedFingerprint = 'bbbbbbbbbbbbbbbb';
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ daemon: { distClosureFingerprint: admittedFingerprint } }) + '\n',
    'utf-8',
  );
  const input = {
    distEntrypoint: join(tmp, 'runtime', 'builds', 'snap-b', 'cli', 'package-dist', 'index.mjs'),
    distClosure: { ok: true, fingerprint: admittedFingerprint },
    runtimeStatePath,
    runtimeBacked: true,
  };

  assert.match(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: 'aaaaaaaaaaaaaaaa',
  }), /different|mismatch|invalid/i);
  assert.match(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: null,
  }), /missing|invalid|fingerprint/i);
  assert.match(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: 'not-a-fingerprint',
  }), /missing|invalid|fingerprint/i);
  assert.equal(resolveDaemonDistRestartReason({
    ...input,
    observedDaemonDistFingerprint: admittedFingerprint,
  }), null);
});

async function reserveLoopbackServerUrls() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'expected loopback listener to expose a numeric port');
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return {
    internalServerUrl: `http://127.0.0.1:${port}`,
    publicServerUrl: `http://localhost:${port}`,
  };
}

function overrideProcessReleaseNameForTest(nextName) {
  const descriptor = Object.getOwnPropertyDescriptor(process.release, 'name');
  assert.ok(descriptor?.configurable, 'process.release.name must be configurable for test');
  Object.defineProperty(process.release, 'name', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    writable: descriptor.writable ?? false,
    value: nextName,
  });
  return () => {
    Object.defineProperty(process.release, 'name', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      writable: descriptor.writable ?? false,
      value: descriptor.value,
    });
  };
}

const FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const statePath = process.argv[1];
if (!statePath) process.exit(2);

const server = http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      distClosureFingerprint:
        process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT || undefined,
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      pid: process.pid,
      httpPort: address.port,
      controlToken: '',
      startTime: new Date().toISOString(),
    }),
    'utf-8',
  );
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 50).unref();
});

setInterval(() => {}, 1000);
`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fakePingAwareDaemonSpawnerSource() {
  return `
const FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT = ${JSON.stringify(FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT)};

function startFakePingAwareDaemon(statePath) {
  const child = spawn(process.execPath, ['-e', FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT, statePath, 'daemon', 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  const ready = new Promise((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  child.unref();
  return { child, ready };
}
`;
}

async function writeStubHappyCli({ cliDir }) {
  // Dist entrypoint exists, but package.json intentionally has no build script.
  // startLocalDaemonWithAuth should launch the daemon via dist (not via bin/happier.mjs).
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    // If the implementation accidentally invokes bin/happier.mjs instead of dist/index.mjs, fail loudly.
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function tagStubCliDistLaunchSource({ cliDir, tag }) {
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  const original = await readFile(distIndexPath, 'utf-8');
  await writeFile(
    distIndexPath,
      `import { writeFileSync as writeHappierTestLaunchMarker } from 'node:fs';\n` +
      `if (process.env.HAPPIER_TEST_DAEMON_SOURCE_MARKER) {\n` +
      `  writeHappierTestLaunchMarker(process.env.HAPPIER_TEST_DAEMON_SOURCE_MARKER, ${JSON.stringify(`${tag}\n`)}, 'utf-8');\n` +
      `}\n` +
      `if (process.env.HAPPIER_TEST_DAEMON_LOCK_MARKER && process.argv[2] === 'daemon' && process.argv[3] === 'start') {\n` +
      `  writeHappierTestLaunchMarker(process.env.HAPPIER_TEST_DAEMON_LOCK_MARKER, process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD || '', 'utf-8');\n` +
      `}\n` +
      `if (process.env.HAPPIER_TEST_DAEMON_CLOSURE_ENV_MARKER && process.argv[2] === 'daemon' && process.argv[3] === 'start') {\n` +
      `  writeHappierTestLaunchMarker(process.env.HAPPIER_TEST_DAEMON_CLOSURE_ENV_MARKER, JSON.stringify({\n` +
      `    distEntrypoint: process.env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT || null,\n` +
      `    subprocessEntrypoint: process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT || null,\n` +
      `    preferTsx: process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX || null,\n` +
      `    fingerprint: process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT || null,\n` +
      `  }) + '\\n', 'utf-8');\n` +
      `}\n` +
      original,
    'utf-8',
  );
  writeStubCliDistBuildManifest(cliDir);
}

async function writeSlowStartStubHappyCli({ cliDir, eventsPath = '' }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
const eventsPath = ${JSON.stringify(String(eventsPath))} || process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

function event(name) {
  if (eventsPath) appendFileSync(eventsPath, name + '\\n', 'utf-8');
}

if (sub === 'stop') {
  event('stop');
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  event('start');
  await delay(400);
  startFakePingAwareDaemon(state);
  await delay(100);
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeDelayedStopStubHappyCli({ cliDir, profileDelayMs = 0, stopDelayMs = 250, startDelayMs = 0 }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args[0] === 'server' && args[1] === 'set' && ${Number(profileDelayMs)} > 0) {
  appendFileSync(process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH, 'profile\\n', 'utf-8');
  await delay(${Number(profileDelayMs)});
}
${buildStubHappierServerSetSource()}
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
const eventsPath = process.env.HAPPIER_TEST_DAEMON_EVENTS_PATH;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

function event(name) {
  if (eventsPath) appendFileSync(eventsPath, name + '\\n', 'utf-8');
}

if (sub === 'stop') {
  event('stop');
  await delay(${Number(stopDelayMs)});
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  event('start');
  await delay(${Number(startDelayMs)});
  await startFakePingAwareDaemon(state).ready;
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writePidOnlyFalseReadyStubHappyCli({ cliDir, daemonProcessSource = 'setInterval(() => {}, 1000)' }) {
  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(daemonProcessSource)}, 'daemon', 'start'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }), 'utf-8');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    binHappierScript: 'process.exit(42);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

test('pid-only false-ready fixture publishes daemon command identity and cleans up its child', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-pid-only-identity-'));
  let fixturePid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writePidOnlyFalseReadyStubHappyCli({ cliDir });
    const cliEntrypoint = join(cliDir, 'dist', 'index.mjs');
    const cliHomeDir = join(tmp, 'cli-home');
    await mkdir(cliHomeDir, { recursive: true });
    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_PROCESS_KIND: 'daemon',
    };

    execFileSync(process.execPath, [cliEntrypoint, 'daemon', 'start'], { env, stdio: 'ignore' });
    fixturePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    const command = execFileSync('ps', ['-p', String(fixturePid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(command, /daemon start/);

    execFileSync(process.execPath, [cliEntrypoint, 'daemon', 'stop'], { env, stdio: 'ignore' });
    await waitForProcessExit({ pid: fixturePid, timeoutMs: 2_000, intervalMs: 25, label: 'fixture daemon' });
    fixturePid = null;
  } finally {
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

async function writeStubHappyCliPackageDistOnly({ cliDir }) {
  const packageDistScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    binHappierScript: 'process.exit(42);\n',
    packageDistIndexScript: packageDistScript.trimStart(),
  });
  return join(cliBinDir, 'happier.mjs');
}

async function writeStubHappyCliWithBrokenPackageDist({ cliDir }) {
  const cliBin = await writeStubHappyCli({ cliDir });
  await mkdir(join(cliDir, 'package-dist'), { recursive: true });
  await writeFile(
    join(cliDir, 'package-dist', 'index.mjs'),
    "import './missing-package-dist-chunk.mjs';\nexport {};\n",
    'utf-8',
  );
  return cliBin;
}

async function writeStubHappyCliWithWorkingDistAndPackageDist({ cliDir }) {
  const cliBin = await writeStubHappyCli({ cliDir });
  await mkdir(join(cliDir, 'package-dist'), { recursive: true });
  await writeFile(
    join(cliDir, 'package-dist', 'index.mjs'),
    'process.exit(86);\n',
    'utf-8',
  );
  return cliBin;
}

async function writeRuntimeSnapshotHappyCli({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const implPath = join(cliDir, 'runtime-cli.mjs');
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;
  await writeFile(implPath, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, `#!/bin/sh\nexec "${process.execPath}" "${implPath}" "$@"\n`, 'utf-8');
  await chmod(cliBin, 0o755);
  return cliBin;
}

async function writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  const packageDistDir = join(cliDir, 'package-dist');
  await mkdir(packageDistDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start-sync' || sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(join(packageDistDir, 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, `#!/bin/sh\nexec "${process.execPath}" "${join(packageDistDir, 'index.mjs')}" "$@"\n`, 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliNodeEntrypoint: join(packageDistDir, 'index.mjs'),
  };
}

async function writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir }) {
  const cliDir = join(snapshotDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const cliBin = join(cliDir, 'happier');
  const cliCommand = join(cliDir, 'happier.mjs');

  const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'start-sync' || sub === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}

if (sub === 'status') {
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

process.exit(0);
  `;

  await writeFile(cliCommand, distScript.trimStart(), 'utf-8');
  await writeFile(cliBin, 'exit 42\n', 'utf-8');
  await chmod(cliBin, 0o755);
  return {
    cliBin,
    cliCommand,
  };
}

async function writePathResolvedRuntimeCommand({ binDir, stopMode = 'kill-state' } = {}) {
  await mkdir(binDir, { recursive: true });
  const commandPath = join(binDir, 'happier-runtime-cmd');
  const serverSetHelperPath = join(binDir, 'happier-runtime-server-set.mjs');
  await writeFile(
    serverSetHelperPath,
    `const args = process.argv.slice(2);\n${buildStubHappierServerSetSource()}\n`,
    'utf-8',
  );
  const script = `#!/bin/sh
HOME_DIR="${'$'}{HAPPIER_HOME_DIR:-${'$'}{HAPPIER_STACK_CLI_HOME_DIR:-}}"
if [ -z "$HOME_DIR" ]; then
  exit 2
fi
STATE="$HOME_DIR/daemon.state.json"
case "$1" in
  server)
    exec "${process.execPath}" "${serverSetHelperPath}" "$@"
    ;;
  daemon)
    case "$2" in
      start)
        "${process.execPath}" -e ${shellQuote(FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT)} "$STATE" daemon start >/dev/null 2>&1 &
        exit 0
        ;;
      stop)
        if [ "${stopMode}" = "kill-state" ] && [ -f "$STATE" ]; then
          pid=$("${process.execPath}" -e "const fs=require('node:fs');const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(raw.pid ?? ''));" "$STATE")
          if [ -n "$pid" ]; then
            kill "$pid" >/dev/null 2>&1 || true
          fi
          rm -f "$STATE"
        fi
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
`;
  await writeFile(commandPath, script, 'utf-8');
  await chmod(commandPath, 0o755);
  return { cliCommand: 'happier-runtime-cmd', commandPath };
}

async function readDaemonPid(statePath) {
  return Number(JSON.parse(await readFile(statePath, 'utf-8')).pid);
}

async function spawnReplacementDaemonForTest({ statePath, env, previousPid }) {
  const child = spawn(process.execPath, ['-e', FAKE_PING_AWARE_DAEMON_CHILD_SCRIPT, statePath], {
    detached: true,
    env,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = await readDaemonPid(statePath);
      if (pid === child.pid && pid !== previousPid) return pid;
    } catch {
      // Replacement has not published its state yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('test replacement daemon did not publish a successor state');
}

async function assertRunnablePriorSourceDaemonAdmission(t, sourceProvenanceEnv) {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-stale-source-admission-'));
  const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
  const cliDir = join(tmp, 'apps', 'cli');
  const cliBin = await writeStubHappyCli({ cliDir });
  await writeHappyMonorepoMarkers(tmp);
  await writeFile(join(tmp, 'package.json'), '{ "private": true }\n', 'utf-8');
  await writeFile(join(tmp, 'pnpm-lock.yaml'), '# root yarn\n', 'utf-8');
  await writeFile(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n');
  await mkdir(join(tmp, 'node_modules'), { recursive: true });
  await writeFile(join(tmp, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nlayoutVersion: 5\nnodeLinker: hoisted\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nlayoutVersion: 5\nnodeLinker: hoisted\n', 'utf-8');

  const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');

  const cliHomeDir = join(tmp, 'stack', 'cli');
  const statePath = join(cliHomeDir, 'daemon.state.json');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

  const sourceEnv = buildDaemonDistGuardEnv({
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_CLI_ROOT_DIR: '',
    ...sourceProvenanceEnv(tmp),
    HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });
  t.after(async () => {
    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      runtimeStatePath,
      env: sourceEnv,
      stackName: 'dev',
    }).catch(() => {});
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(tmp, { recursive: true, force: true });
  });

  await prepareSelectedSourceCliFixture(tmp, cliDir, dirname(runtimeStatePath));
  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    runtimeStatePath,
    isShuttingDown: () => false,
    forceRestart: false,
    env: sourceEnv,
    stackName: 'dev',
    cliIdentity: 'default',
  });
  const livePid = await readDaemonPid(statePath);

  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    runtimeStatePath,
    isShuttingDown: () => false,
    forceRestart: false,
    env: sourceEnv,
    stackName: 'dev',
    cliIdentity: 'default',
  });
  assert.equal(await readDaemonPid(statePath), livePid);
}

test('source daemon admission freezes source and preserves the exact live daemon', { skip: process.platform !== 'linux' }, async (t) => {
  await assertRunnablePriorSourceDaemonAdmission(t, (tmp) => ({ HAPPIER_STACK_REPO_DIR: tmp }));
});

test('CLI-root-only source daemon admission freezes source and preserves the exact live daemon', { skip: process.platform !== 'linux' }, async (t) => {
  await assertRunnablePriorSourceDaemonAdmission(t, (tmp) => ({ HAPPIER_STACK_CLI_ROOT_DIR: tmp }));
});

test('source daemon startup uses its immutable generation without invoking a failing shared-dist publisher', { skip: process.platform !== 'linux' }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-build-failed-fallback-'));
  const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
  const cliDir = join(tmp, 'apps', 'cli');
  const cliBin = await writeStubHappyCli({ cliDir });
  await writeHappyMonorepoMarkers(tmp);
  await writeFile(join(tmp, 'package.json'), '{ "private": true }\n', 'utf-8');
  await writeFile(join(tmp, 'pnpm-lock.yaml'), '# root yarn\n', 'utf-8');
  await writeFile(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n');
  await mkdir(join(tmp, 'node_modules'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(
    join(cliDir, 'package.json'),
    JSON.stringify({ name: 'fake-cli', private: true, scripts: { build: 'exit 47', 'build:prepared': 'exit 47' } }) + '\n',
    'utf-8',
  );
  const fakeBinDir = join(tmp, 'fake-bin');
  const pnpmPath = join(fakeBinDir, 'pnpm');
  const buildFailurePath = join(tmp, 'build-failure-code');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    pnpmPath,
    `#!${process.execPath}\n` +
      `if (process.argv.includes('--version')) { console.log('12.14.0'); process.exit(0); }\n` +
      `if (process.argv.includes('build:prepared')) { require('node:fs').writeFileSync(${JSON.stringify(buildFailurePath)}, '47\\n'); process.exit(47); }\n` +
      `process.exit(0);\n`,
    'utf-8',
  );
  await chmod(pnpmPath, 0o755);

  const cliHomeDir = join(tmp, 'stack', 'cli');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
  const priorDistSource = await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8');
  const priorDistManifest = await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8');
  const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
  const { env } = await installWorkspaceAdmissionProcessFixture(t, tmp, {
    env: buildDaemonDistGuardEnv({
      HAPPIER_STACK_REPO_DIR: tmp,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_CLI_BUILD_MODE: 'always',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '5000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      npm_execpath: '',
      npm_node_execpath: '',
    }),
  });
  t.after(async () => {
    await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir, runtimeStatePath, env, stackName: 'dev' }).catch(() => {});
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(tmp, { recursive: true, force: true });
  });
  const immutable = await prepareSelectedSourceCliFixture(tmp, cliDir, dirname(runtimeStatePath));
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

  assert.equal((await checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env })).status, 'running');
  assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded, immutable.identity);
  const livePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
  assert.equal(await readDaemonPid(join(cliHomeDir, 'daemon.state.json')), livePid);
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), priorDistSource);
  assert.equal(await readFile(join(cliDir, 'dist', '.build-manifest.json'), 'utf-8'), priorDistManifest);
  assert.equal(existsSync(buildFailurePath), false, 'immutable startup and adoption never invoke the shared-dist publisher');
});

test('CLI-root-only source dist admission consumes the current build result', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-cli-root-admission-'));
  const cliDir = join(tmp, 'apps', 'cli');
  const cliBin = await writeStubHappyCli({ cliDir });
  await writeHappyMonorepoMarkers(tmp);
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const buildCalls = [];
  const admission = await ensureHappierCliDistExists({
    cliBin,
    env: buildDaemonDistGuardEnv({
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_CLI_ROOT_DIR: tmp,
    }),
  }, {
    ensureCliBuiltImpl: async (actualCliDir) => {
      buildCalls.push(actualCliDir);
      return { built: false, current: false, reason: 'mode_never' };
    },
  });

  assert.deepEqual(buildCalls, [cliDir]);
  assert.equal(admission.ok, true);
  assert.equal(admission.current, false);
  assert.equal(admission.generationAdmissionRequired, true);
});

test('startLocalDaemonWithAuth requires daemon control ping before accepting running daemon state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-ping-ready-'));
  let fixturePid = null;
  let shouldShutdown = false;
  let startPromise = null;
  let stateInspection = null;
  let cleanupDaemon = async () => {};
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    // Keep the real PID-only process pending until startup observes it and the
    // caller cancels. Preparation uses the owner's ordinary deadline.
    const cliBin = await writePidOnlyFalseReadyStubHappyCli({
      cliDir,
      daemonProcessSource: 'setInterval(() => {}, 1000)',
    });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    });

    cleanupDaemon = async () => {
      fixturePid ??= await readDaemonPid(join(cliHomeDir, 'daemon.state.json')).catch(() => null);
      await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir, env });
      if (fixturePid) {
        await waitForProcessExit({ pid: fixturePid, timeoutMs: 2_000, intervalMs: 25, label: 'fixture daemon' });
        fixturePid = null;
      }
    };
    let resolveUnreadyState;
    let rejectUnreadyState;
    const unreadyState = new Promise((resolve, reject) => {
      resolveUnreadyState = resolve;
      rejectUnreadyState = reject;
    });
    startPromise = startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => {
        // Observe the real process/control boundary on the existing startup
        // loop; a live PID alone must not settle startup as ready.
        if (!shouldShutdown && !stateInspection) {
          stateInspection = checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env })
            .then((state) => {
              if (state.status === 'unreachable') {
                fixturePid = state.pid;
                resolveUnreadyState(state);
              }
            })
            .catch(rejectUnreadyState)
            .finally(() => { stateInspection = null; });
        }
        return shouldShutdown;
      },
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const observation = await Promise.race([
      unreadyState.then((state) => ({ status: 'unready', state })),
      startPromise.then(
        () => ({ status: 'ready' }),
        (error) => ({ status: 'failed', error }),
      ),
    ]);
    assert.equal(observation.status, 'unready', observation.error?.stack ?? 'PID-only daemon must remain unready until control ping succeeds');
    assert.equal(observation.state.reason, 'missing_http_port');
    shouldShutdown = true;
    await assert.rejects(startPromise, /startup was cancelled before readiness/i);
  } finally {
    shouldShutdown = true;
    try {
      await startPromise?.catch(() => {});
      await stateInspection;
      await cleanupDaemon();
    } finally {
      if (fixturePid) {
        try { process.kill(fixturePid, 'SIGKILL'); } catch {}
      }
      await rm(tmp, { recursive: true, force: true });
    }
  }
});

test('startLocalDaemonWithAuth does not require a second CLI build when dist/index.mjs already exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-guard-'));
  let fixturePid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1500',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    });

    // If startLocalDaemonWithAuth tries to rebuild, this will fail because package.json has no build script.
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    fixturePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    assert.ok(fixturePid > 1, 'expected daemon to write daemon state');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
    await waitForProcessExit({ pid: fixturePid, timeoutMs: 2_000, intervalMs: 25, label: 'fixture daemon' });
    fixturePid = null;
  } finally {
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('source daemon starts its immutable generation despite an incomplete shared-dist publication', { skip: process.platform !== 'linux' }, async (t) => {
  // This temporary publisher and caller model independent, uncharged work,
  // not a lock-only waiter inside the public runner's charged envelope.
  withPatchedProcessEnv(t, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined });
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-lock-wait-'));
  let publisherPromise = null;
  let startPromise = null;
  let fixturePid = null;
  let shouldShutdown = false;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const distScript = await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8');
    await writeHappyMonorepoMarkers(tmp);
    await prepareCurrentSourceCliFixture(tmp, cliDir);
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    const immutable = await prepareSelectedSourceCliFixture(tmp, cliDir, dirname(runtimeStatePath));
    await rm(join(cliDir, 'dist'), { recursive: true, force: true });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const lockPath = resolveCliDistBuildLockPath(tmp);
    let publisherEntered;
    const publisherReady = new Promise((resolve) => { publisherEntered = resolve; });
    publisherPromise = withCliDistBuildLock(
      async () => {
        publisherEntered();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await mkdir(join(cliDir, 'dist'), { recursive: true });
        await writeFile(join(cliDir, 'dist', 'index.mjs'), distScript, 'utf-8');
        writeStubCliDistBuildManifest(cliDir);
      },
      { lockPath },
    );
    // Observe setup failures immediately; the real publisher releases its
    // authenticated lease only after the complete manifest is available.
    void publisherPromise.catch(() => {});
    await Promise.race([publisherReady, publisherPromise]);
    assert.equal(existsSync(join(cliDir, 'dist', 'index.mjs')), false,
      'startup must begin while the concurrent publication is incomplete');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
    });

    startPromise = startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      runtimeStatePath,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => shouldShutdown,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    await Promise.all([publisherPromise, startPromise]);
    assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded, immutable.identity);

    fixturePid = await readDaemonPid(join(cliHomeDir, 'daemon.state.json'));
    assert.ok(fixturePid > 1, 'expected the daemon to start from its prepared immutable generation');
    assert.equal(existsSync(lockPath), false, 'startup must release its final publication lease');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
    await waitForProcessExit({ pid: fixturePid, timeoutMs: 2_000, intervalMs: 25, label: 'fixture daemon' });
    fixturePid = null;
  } finally {
    shouldShutdown = true;
    await publisherPromise?.catch(() => {});
    await startPromise?.catch(() => {});
    if (!fixturePid) {
      const state = await readFile(join(tmp, 'stack', 'cli', 'daemon.state.json'), 'utf-8').catch(() => null);
      if (state) fixturePid = Number(JSON.parse(state).pid);
    }
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
      await waitForProcessExit({ pid: fixturePid, timeoutMs: 2_000, intervalMs: 25, label: 'fixture daemon cleanup' }).catch(() => {});
    }
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps a running daemon when a concurrent CLI build removes dist before restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-race-'));
  let raceTimer = null;
  let firstPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeDelayedStopStubHappyCli({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1500',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    firstPid = await readDaemonPid(statePath);
    assert.ok(Number.isFinite(firstPid) && firstPid > 1);
    await writeFile(eventsPath, '', 'utf-8');

    const rootLockDir = join(tmp, '.project', 'tmp');
    const lockPaths = [
      join(rootLockDir, 'cli-dist-build.lock'),
      join(cliDir, '.dist.hstack-build.lock'),
    ];
    await mkdir(rootLockDir, { recursive: true });
    const lockOwner = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    for (const lockPath of lockPaths) {
      await writeFile(lockPath, lockOwner, 'utf-8');
    }

    raceTimer = setTimeout(async () => {
      try {
        await rm(join(cliDir, '.dist.hstack-backup'), { recursive: true, force: true });
        await rename(join(cliDir, 'dist'), join(cliDir, '.dist.hstack-backup'));
      } catch {
        // The assertions below surface any missed race setup.
      } finally {
        await Promise.all(lockPaths.map((lockPath) => rm(lockPath, { force: true }).catch(() => {})));
      }
    }, 75);

    await assert.doesNotReject(() =>
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }),
    );

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.equal(events.filter((event) => event === 'stop').length, 0);

    const stateAfterRace = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(Number(stateAfterRace.pid), firstPid);
    assert.doesNotThrow(() => process.kill(firstPid, 0));

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
    if (Number.isFinite(firstPid) && firstPid > 1) {
      try {
        process.kill(firstPid, 'SIGTERM');
      } catch {}
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistEntrypoint rejects drive-root-shaped dist escapes', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-drive-root-escape-'));
  try {
    const activeCliDir = join(tmp, 'active', 'apps', 'cli');
    const driveRootedEscape = join(activeCliDir, 'D:\\stale\\apps\\cli\\dist\\index.mjs');

    const rejected = resolveGuardedLocalCliDistEntrypoint({
      distEntrypoint: driveRootedEscape,
      activeCliDir,
    });

    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /outside_active_cli_dir/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistEntrypoint accepts a missing dist below a symlinked active CLI root', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink canonicalization regression');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-missing-dist-symlink-'));
  try {
    const realRepoDir = join(tmp, 'real-repo');
    const linkedRepoDir = join(tmp, 'linked-repo');
    const activeCliDir = join(linkedRepoDir, 'apps', 'cli');
    await mkdir(join(realRepoDir, 'apps', 'cli'), { recursive: true });
    await symlink(realRepoDir, linkedRepoDir, 'dir');

    const accepted = resolveGuardedLocalCliDistEntrypoint({
      distEntrypoint: join(activeCliDir, 'dist', 'index.mjs'),
      activeCliDir,
    });

    assert.equal(accepted.ok, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('isGuardedSourceCliDistEntrypoint treats repointed active dist as guarded source dist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-dist-guarded-'));
  try {
    const activeCliDir = join(tmp, 'active', 'apps', 'cli');
    const staleCliDir = join(tmp, 'T', 'hstack-runtime-start-fixture-stale', 'apps', 'cli');
    await writeStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });

    assert.equal(
      isGuardedSourceCliDistEntrypoint({
        cliBin: staleCliBin,
        distEntrypoint: join(activeCliDir, 'dist', 'index.mjs'),
        activeCliDir,
      }),
      true,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveGuardedLocalCliDistSelection canonicalizes stale symlinked dist to active checkout', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-stale-symlink-owner-'));
  try {
    const activeRoot = join(tmp, 'active');
    const staleRoot = join(tmp, 'T', 'hstack-runtime-start-fixture-stale');
    await writeHappyMonorepoMarkers(activeRoot);

    const activeCliDir = join(activeRoot, 'apps', 'cli');
    const staleCliDir = join(staleRoot, 'apps', 'cli');
    await writeStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });
    await rm(join(staleCliDir, 'dist'), { recursive: true, force: true });
    await symlink(join(activeCliDir, 'dist'), join(staleCliDir, 'dist'), 'dir');

    const selection = resolveGuardedLocalCliDistSelection({
      cliBin: staleCliBin,
      activeCliDir,
    });

    assert.equal(selection.resolvedDist?.distEntrypoint, join(activeCliDir, 'dist', 'index.mjs'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('source daemon with stale symlinked dist loads the active immutable generation while publication is busy', { skip: process.platform !== 'linux' }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-stale-symlink-lock-'));
  let lockHolder = null;
  let fixturePid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const activeRoot = join(tmp, 'active');
    const staleRoot = join(tmp, 'T', 'hstack-runtime-start-fixture-stale');
    await writeHappyMonorepoMarkers(activeRoot);

    const activeCliDir = join(activeRoot, 'apps', 'cli');
    const staleCliDir = join(staleRoot, 'apps', 'cli');
    await writeStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });
    await rm(join(staleCliDir, 'dist'), { recursive: true, force: true });
    await symlink(join(activeCliDir, 'dist'), join(staleCliDir, 'dist'), 'dir');
    const dependencyEnv = await prepareCurrentSourceCliFixture(activeRoot, activeCliDir);
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    const immutable = await prepareSelectedSourceCliFixture(activeRoot, activeCliDir, dirname(runtimeStatePath));
    const { env } = await installWorkspaceAdmissionProcessFixture(t, tmp, {
      env: buildDaemonDistGuardEnv({
        ...dependencyEnv,
        HAPPIER_STACK_REPO_DIR: activeRoot,
        HAPPIER_STACK_CLI_BUILD: '1',
      }),
    });

    await writeFile(join(activeCliDir, 'dist', 'index.mjs'), "import './missing-active-build-chunk.mjs';\n", 'utf-8');

    const activeLockPath = join(activeRoot, '.project', 'tmp', 'cli-dist-build.lock');
    await mkdir(join(activeRoot, '.project', 'tmp'), { recursive: true });
    lockHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await writeFile(
      activeLockPath,
      JSON.stringify({
        pid: lockHolder.pid,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      'utf-8',
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await Promise.race([
      startLocalDaemonWithAuth({
        cliBin: staleCliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        runtimeStatePath,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('timed out waiting for daemon start while the active cli dist build lock was active'));
        }, 10_000);
      }),
    ]);

    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    assert.ok(Number(daemonState.pid) > 1, 'the immutable daemon starts while shared dist remains unavailable');
    assert.equal(JSON.parse(await readFile(activeLockPath, 'utf8')).pid, lockHolder.pid);
    assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded, immutable.identity);
    fixturePid = Number(daemonState.pid);

    await stopLocalDaemon({
      cliBin: staleCliBin,
      internalServerUrl,
      cliHomeDir,
      runtimeStatePath,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    await waitForProcessExit({ pid: fixturePid, timeoutMs: 2_000, intervalMs: 25, label: 'fixture daemon' });
    fixturePid = null;
  } finally {
    if (fixturePid) {
      try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
    if (lockHolder && lockHolder.exitCode == null) {
      lockHolder.kill('SIGTERM');
    }
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth records rebuilt dist fingerprint when dist is missing at command resolution time', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-rebuild-fingerprint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const monoRoot = join(cliDir, '..', '..');
    const distScript = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
if (args[0] !== 'daemon') process.exit(0);
if (args[1] === '--help') process.exit(0);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const state = join(home, 'daemon.state.json');

${fakePingAwareDaemonSpawnerSource()}

if (args[1] === 'stop') {
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}
if (args[1] === 'start') {
  startFakePingAwareDaemon(state);
  process.exit(0);
}
process.exit(0);
`;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: JSON.stringify({
        scripts: {
          build: 'node scripts/build.mjs',
          'build:prepared': 'node scripts/build.mjs',
        },
      }) + '\n',
      binHappierScript: 'process.exit(42);\n',
    });
    await mkdir(join(cliDir, 'scripts'), { recursive: true });
    await writeFile(
      join(cliDir, 'scripts', 'build.mjs'),
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `import cliDistBuildManifest from ${JSON.stringify(CLI_DIST_BUILD_MANIFEST_MODULE_URL)};\n` +
        `const dist = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR || join(process.cwd(), 'dist');\n` +
        `mkdirSync(dist, { recursive: true });\n` +
        `writeFileSync(join(dist, 'index.mjs'), ${JSON.stringify(distScript.trimStart())}, 'utf-8');\n` +
        `cliDistBuildManifest.writeCliDistBuildManifest(join(dist, 'index.mjs'), { outputDir: dist });\n`,
      'utf-8',
    );
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const runtimeStatePath = join(tmp, 'stack', 'runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'dev',
      ownerPid: process.pid,
    });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const cliBin = join(cliBinDir, 'happier.mjs');
    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_HOME_DIR: join(tmp, 'hstack-home'),
      HAPPIER_STACK_TUI: '0',
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.match(
      String(runtimeState?.daemon?.distClosureFingerprint ?? ''),
      /^[a-f0-9]{16}$/,
      'expected rebuilt dist fingerprint to be recorded',
    );

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth coalesces concurrent non-forced starts behind an active restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-lifecycle-lock-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeSlowStartStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
    });

    await Promise.all([
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: false,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        });
      })(),
    ]);

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.equal(events.filter((event) => event === 'start').length, 1);

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth restarts a running source dist daemon after a sibling dist chunk is rebuilt', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-stale-source-dist-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const distIndexPath = join(cliDir, 'dist', 'index.mjs');
    const siblingChunkPath = join(cliDir, 'dist', 'runtime-chunk.mjs');
    await writeFile(siblingChunkPath, 'export const build = "v1";\n', 'utf-8');
    const distIndexSource = await readFile(distIndexPath, 'utf-8');
    await writeFile(distIndexPath, `import './runtime-chunk.mjs';\n${distIndexSource}`, 'utf-8');
    writeStubCliDistBuildManifest(cliDir);
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const stackStorageDir = join(tmp, 'stack-storage');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(stackStorageDir, 'dev', 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'dev',
      ownerPid: process.pid,
    });

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_STORAGE_DIR: stackStorageDir,
    });

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);
    const runtimeStateAfterFirstStart = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.match(
      String(runtimeStateAfterFirstStart?.daemon?.distClosureFingerprint ?? ''),
      /^[a-f0-9]{16}$/,
      'expected stack.runtime.json to persist the daemon dist closure fingerprint after the first start',
    );

    await writeFile(siblingChunkPath, 'export const build = "v2";\n', 'utf-8');
    writeStubCliDistBuildManifest(cliDir);

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart: false,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.ok(Number.isFinite(firstPid) && firstPid > 0);
    assert.ok(Number.isFinite(secondPid) && secondPid > 0);
    assert.notEqual(secondPid, firstPid);

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers package-dist/index.mjs when source dist is absent', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-package-dist-guard-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCliPackageDistOnly({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    assert.ok(Number(daemonState.pid) > 1, 'expected package-dist daemon to write daemon state');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth prefers guarded source dist/index.mjs over package-dist/index.mjs when both exist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-preferred-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCliWithWorkingDistAndPackageDist({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonState = JSON.parse(await readFile(join(cliHomeDir, 'daemon.state.json'), 'utf-8'));
    assert.ok(Number(daemonState.pid) > 1, 'expected package-dist daemon to write daemon state');

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('source daemon repoints a stale cliBin to the active immutable source launch without a publication lease', { skip: process.platform !== 'linux' }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-checkout-repoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const activeRoot = join(tmp, 'active');
    const staleRoot = join(tmp, 'T', 'hstack-runtime-start-fixture-stale');
    await writeHappyMonorepoMarkers(activeRoot);

    const activeCliDir = join(activeRoot, 'apps', 'cli');
    const staleCliDir = join(staleRoot, 'apps', 'cli');
    await writeStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });
    await tagStubCliDistLaunchSource({ cliDir: activeCliDir, tag: 'active' });
    await tagStubCliDistLaunchSource({ cliDir: staleCliDir, tag: 'stale' });
    const dependencyEnv = await prepareCurrentSourceCliFixture(activeRoot, activeCliDir);

    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    const immutable = await prepareSelectedSourceCliFixture(activeRoot, activeCliDir, dirname(runtimeStatePath));

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const markerPath = join(tmp, 'daemon-launch-source.txt');
    const lockMarkerPath = join(tmp, 'daemon-launch-lock-lease.txt');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const { env } = await installWorkspaceAdmissionProcessFixture(t, tmp, {
      env: buildDaemonDistGuardEnv({
        ...dependencyEnv,
        HAPPIER_STACK_REPO_DIR: activeRoot,
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_TEST_DAEMON_SOURCE_MARKER: markerPath,
        HAPPIER_TEST_DAEMON_LOCK_MARKER: lockMarkerPath,
      }),
    });

    try {
      await startLocalDaemonWithAuth({
        cliBin: staleCliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        runtimeStatePath,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      });

      assert.equal(await readFile(markerPath, 'utf-8'), 'active\n');
      assert.equal(await readFile(lockMarkerPath, 'utf-8'), '');
      assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded, immutable.identity);
    } finally {
      await stopLocalDaemon({
        cliBin: staleCliBin,
        internalServerUrl,
        cliHomeDir,
        runtimeStatePath,
        env,
      });
    }
  } finally {
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects symlinked active dist outside the active checkout', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-checkout-symlink-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const activeRoot = join(tmp, 'active');
    const staleRoot = join(tmp, 'T', 'hstack-runtime-start-fixture-stale');
    await writeHappyMonorepoMarkers(activeRoot);

    const activeCliDir = join(activeRoot, 'apps', 'cli');
    const staleCliDir = join(staleRoot, 'apps', 'cli');
    const activeCliBin = await writeStubHappyCli({ cliDir: activeCliDir });
    await writeStubHappyCli({ cliDir: staleCliDir });
    await rm(join(activeCliDir, 'dist'), { recursive: true, force: true });
    await symlink(join(staleCliDir, 'dist'), join(activeCliDir, 'dist'), 'dir');

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_REPO_DIR: activeRoot,
      HAPPIER_STACK_CLI_BUILD: '0',
    });

    try {
      await assert.rejects(
        () => startLocalDaemonWithAuth({
          cliBin: activeCliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
        /outside_active_cli_dir|outside the active stack repo/i,
      );
    } finally {
      await stopLocalDaemon({
        cliBin: activeCliBin,
        internalServerUrl,
        cliHomeDir,
        env,
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon uses the active immutable launch when stale cliBin dist is missing', { skip: process.platform !== 'linux' }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-active-stop-repoint-'));
  let daemonPid = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const activeRoot = join(tmp, 'active');
    const staleRoot = join(tmp, 'T', 'hstack-runtime-start-fixture-stale');
    await writeHappyMonorepoMarkers(activeRoot);

    const activeCliDir = join(activeRoot, 'apps', 'cli');
    const staleCliDir = join(staleRoot, 'apps', 'cli');
    await writeDelayedStopStubHappyCli({ cliDir: activeCliDir });
    const staleCliBin = await writeStubHappyCli({ cliDir: staleCliDir });
    await rm(join(staleCliDir, 'dist'), { recursive: true, force: true });
    const dependencyEnv = await prepareCurrentSourceCliFixture(activeRoot, activeCliDir);

    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await prepareSelectedSourceCliFixture(activeRoot, activeCliDir, dirname(runtimeStatePath));

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const eventsPath = join(tmp, 'daemon-events.log');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const { env } = await installWorkspaceAdmissionProcessFixture(t, tmp, {
      env: buildDaemonDistGuardEnv({
        ...dependencyEnv,
        HAPPIER_STACK_REPO_DIR: activeRoot,
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_TEST_DAEMON_EVENTS_PATH: eventsPath,
      }),
    });

    await startLocalDaemonWithAuth({
      cliBin: staleCliBin,
      cliHomeDir,
      runtimeStatePath,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    daemonPid = await readDaemonPid(statePath);
    await writeFile(eventsPath, '', 'utf-8');

    await stopLocalDaemon({
      cliBin: staleCliBin,
      internalServerUrl,
      cliHomeDir,
      runtimeStatePath,
      env,
    });

    const events = (await readFile(eventsPath, 'utf-8')).trim().split(/\n+/).filter(Boolean);
    assert.ok(events.includes('stop'), 'expected stopLocalDaemon to invoke the active checkout daemon stop command');
  } finally {
    if (Number.isFinite(daemonPid) && daemonPid > 1) {
      try {
        process.kill(daemonPid, 'SIGTERM');
      } catch {}
    }
    const { setBundleReadOnly } = await import('./build/build_source_runtime.mjs');
    await setBundleReadOnly(join(tmp, 'source-bundles'), false).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth falls back to dist when package-dist exists but is incomplete', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-package-dist-incomplete-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCliWithBrokenPackageDist({ cliDir });
    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects incomplete dist when index imports missing chunks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-dist-incomplete-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });

    // Simulate a partially built dist where entrypoint exists but references a missing chunk.
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
      "import './doctor-missing-chunk.mjs';\nexport {};\n",
      'utf-8',
    );

    await writeFile(join(tmp, 'package.json'), '{}\n', 'utf-8');
    runGit(['init'], tmp);
    runGit(['config', 'user.email', 'test@example.com'], tmp);
    runGit(['config', 'user.name', 'Test User'], tmp);
    runGit(['add', '.'], tmp);
    runGit(['commit', '-m', 'init'], tmp);

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
    });

    await assert.rejects(
      () =>
        startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
          cliIdentity: 'default',
        }),
      /dist entrypoint is missing or incomplete|missing_module/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth accepts a runtime snapshot cli executable without requiring dist/index.mjs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-cli-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const cliBin = await writeRuntimeSnapshotHappyCli({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

for (const { matchingLaunch, nativeLauncher } of [
  { matchingLaunch: true, nativeLauncher: true },
  { matchingLaunch: true, nativeLauncher: false },
  { matchingLaunch: false, nativeLauncher: false },
]) {
  test(`manual source daemon start consumes and attests its recorded launch (matching=${matchingLaunch}, native=${nativeLauncher})`, async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-source-daemon-attestation-'));
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const launch = nativeLauncher
      ? { cliBin: await writeRuntimeSnapshotHappyCli({ snapshotDir: join(tmp, 'bundle') }) }
      : await writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir: join(tmp, 'bundle') });
    const cliBin = launch.cliBin;
    const cliCommand = launch.cliCommand ?? cliBin;
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const env = buildDaemonDistGuardEnv({ HAPPIER_STACK_CLI_BUILD: '0' });
    try {
      await mkdir(cliHomeDir, { recursive: true });
      await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n');
      await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }));
      // The retained selection is authoritative even if a long-lived caller
      // still supplies its former complete launch graph.
      const otherLaunch = !matchingLaunch
        ? await writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir: join(tmp, 'other-bundle') })
        : null;
      // A stale caller may carry a native launcher, but the source producer
      // retains emitted JavaScript, never that launcher's shell wrapper.
      const selectedEntrypoint = otherLaunch?.cliCommand
        ?? (nativeLauncher ? join(dirname(cliBin), 'runtime-cli.mjs') : cliCommand);
      const startsPath = join(tmp, 'launch-starts');
      if (otherLaunch) {
        for (const [command, identity] of [[cliCommand, 'stale'], [otherLaunch.cliCommand, 'selected']]) {
          const source = await readFile(command, 'utf8');
          await writeFile(command, `import { appendFileSync as recordFixtureStart } from 'node:fs';
if (process.argv[2] === 'daemon' && process.argv[3] === 'start') recordFixtureStart(${JSON.stringify(startsPath)}, ${JSON.stringify(`${identity}\n`)});
${source}`);
        }
      }
      await recordStackRuntimeStart(runtimeStatePath, { stackName: 'source-attestation', ownerPid: process.pid,
        sourceRuntimeIdentities: { daemon: { selected: 'prepared-source', loaded: null } },
        sourceRuntimeLaunch: { entrypoint: selectedEntrypoint,
          cliDir: dirname(selectedEntrypoint), env: {} } });
      const result = await startLocalDaemonWithAuth({ cliBin, cliCommand, cliHomeDir, internalServerUrl, publicServerUrl,
        runtimeStatePath, env, stackName: 'source-attestation', isShuttingDown: () => false });
      assert.equal(result.started, true);
      assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded,
        'prepared-source');
      if (otherLaunch) {
        const starts = await readFile(startsPath, 'utf8');
        assert.match(starts, /selected/);
        assert.doesNotMatch(starts, /stale/);
      }
      if (matchingLaunch) {
        await recordStackRuntimeUpdate(runtimeStatePath, { sourceRuntimeIdentities: { daemon: { loaded: null } } });
        const adopted = await startLocalDaemonWithAuth({ cliBin, cliCommand, cliHomeDir, internalServerUrl, publicServerUrl,
          runtimeStatePath, env, stackName: 'source-attestation', preserveExistingRunning: true });
        assert.equal(adopted.started, false);
        assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded, null);
      }
    } finally {
      await stopLocalDaemon({ cliBin, cliCommand, cliHomeDir, internalServerUrl, env });
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('startLocalDaemonWithAuth rejects runtime snapshot payload changed after build-manifest admission', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-node-entrypoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });
    const { manifest } = writeStubCliDistBuildManifest(join(snapshotDir, 'cli'), {
      entrypointDir: 'package-dist',
    });
    const admittedFingerprint = manifest.fingerprint;
    await writeFile(
      cliNodeEntrypoint,
      `${await readFile(cliNodeEntrypoint, 'utf-8')}\n// arbitrary fixture bytes written after admission\n`,
      'utf-8',
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin,
        cliNodeEntrypoint,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env: buildDaemonDistGuardEnv({
          HAPPIER_STACK_CLI_BUILD: '0',
        }),
        stackName: 'dev',
        cliIdentity: 'default',
        runtimeStatePath,
        runtimeBacked: true,
        admittedDistClosureFingerprint: admittedFingerprint,
      }),
      { code: 'EIMMUTABLERUNTIMEDAEMONCLOSURE' },
    );
    assert.equal(existsSync(join(cliHomeDir, 'daemon.state.json')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth ordinary runtime adoption replaces closure A with admitted closure B', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-adoption-mismatch-'));
  let cleanupDaemon = null;
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-b');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });
    const cliDir = join(snapshotDir, 'cli');
    const firstManifest = writeStubCliDistBuildManifest(cliDir, { entrypointDir: 'package-dist' }).manifest;

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const statePath = join(cliHomeDir, 'daemon.state.json');
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName: 'dev', ownerPid: process.pid });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
    });
    const start = (admittedDistClosureFingerprint, forceRestart = false, preserveExistingRunning = false) => startLocalDaemonWithAuth({
      cliBin,
      cliCommand: cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => false,
      forceRestart,
      preserveExistingRunning,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
      runtimeBacked: true,
      admittedDistClosureFingerprint,
    });
    cleanupDaemon = () => stopLocalDaemon({ cliBin, cliCommand: cliBin, cliNodeEntrypoint,
      internalServerUrl, cliHomeDir, runtimeStatePath, env });

    const initialStart = await start(firstManifest.fingerprint, true);
    const firstPid = await readDaemonPid(statePath);

    await writeFile(cliNodeEntrypoint, `${await readFile(cliNodeEntrypoint, 'utf-8')}\n// closure B\n`, 'utf-8');
    const secondManifest = writeStubCliDistBuildManifest(cliDir, { entrypointDir: 'package-dist' }).manifest;
    assert.notEqual(secondManifest.fingerprint, firstManifest.fingerprint);
    const projected = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        ...projected,
        daemon: { ...(projected.daemon ?? {}), distClosureFingerprint: secondManifest.fingerprint },
      }) + '\n',
      'utf-8',
    );

    const replacementStart = await start(secondManifest.fingerprint, false, true);
    const secondPid = await readDaemonPid(statePath);
    assert.notEqual(secondPid, firstPid, 'preserve-existing must replace authenticated closure A even when projection already says B');

    const adoptedStart = await start(secondManifest.fingerprint);
    assert.equal(await readDaemonPid(statePath), secondPid, 'matching admitted closure must remain adopted');

    const daemonBaseEnv = await getDaemonEnv({
      baseEnv: env,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    let priorPid = secondPid;
    for (const observedFingerprint of [null, 'not-a-fingerprint']) {
      process.kill(priorPid, 'SIGTERM');
      const untrustedPid = await spawnReplacementDaemonForTest({
        statePath,
        previousPid: priorPid,
        env: {
          ...daemonBaseEnv,
          ...(observedFingerprint
            ? { HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: observedFingerprint }
            : {}),
        },
      });
      await start(secondManifest.fingerprint, false, true);
      priorPid = await readDaemonPid(statePath);
      assert.notEqual(
        priorPid,
        untrustedPid,
        `${observedFingerprint ? 'malformed' : 'missing'} authenticated identity must not survive preserve-existing adoption`,
      );
    }

    await cleanupDaemon();
    cleanupDaemon = null;
    assert.deepEqual(initialStart, { started: true });
    assert.deepEqual(replacementStart, { started: true });
    assert.deepEqual(adoptedStart, { started: false });
  } finally {
    try { await cleanupDaemon?.(); }
    finally { await rm(tmp, { recursive: true, force: true }); }
  }
});

test('startLocalDaemonWithAuth rejects a runtime snapshot when admitted and build-manifest fingerprints differ', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-manifest-mismatch-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });
    writeStubCliDistBuildManifest(join(snapshotDir, 'cli'), { entrypointDir: 'package-dist' });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    const runtimeStatePath = join(tmp, 'stack', 'stack.runtime.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin,
        cliNodeEntrypoint,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env: buildDaemonDistGuardEnv({ HAPPIER_STACK_CLI_BUILD: '0' }),
        stackName: 'dev',
        cliIdentity: 'default',
        runtimeStatePath,
        runtimeBacked: true,
        admittedDistClosureFingerprint: 'ffffffffffffffff',
      }),
      (error) => error?.code === 'EIMMUTABLERUNTIMEDAEMONCLOSURE',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth still prefers a runtime snapshot node entrypoint when the host runtime is bun', async () => {
  const restoreProcessReleaseName = overrideProcessReleaseNameForTest('bun');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-bun-node-entrypoint-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliNodeEntrypoint } = await writeRuntimeSnapshotHappyCliWithNodeEntrypoint({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliNodeEntrypoint,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    restoreProcessReleaseName();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth runs runtime snapshot JS commands through node when no separate node entrypoint exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-js-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const snapshotDir = join(tmp, 'runtime', 'builds', 'snap-auth');
    const { cliBin, cliCommand } = await writeRuntimeSnapshotHappyCliJsCommand({ snapshotDir });

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env: buildDaemonDistGuardEnv({
        HAPPIER_STACK_CLI_BUILD: '0',
      }),
      stackName: 'dev',
      cliIdentity: 'default',
    });

    await stopLocalDaemon({
      cliBin,
      cliCommand,
      internalServerUrl,
      cliHomeDir,
    });

    assert.ok(true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth rejects missing runtime snapshot command paths before spawning', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-missing-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliNodeEntrypoint: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'package-dist', 'index.mjs'),
        cliCommand: join(tmp, 'runtime', 'builds', 'snap-auth', 'cli', 'happier'),
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env: buildDaemonDistGuardEnv({
          HAPPIER_STACK_CLI_BUILD: '0',
        }),
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /runtime snapshot.*missing|runtime launch path.*missing|missing runtime/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth restarts PATH-resolved runtime commands instead of treating the command name as a dist path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-path-runtime-command-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.ok(Number.isFinite(firstPid) && firstPid > 0);
    assert.ok(Number.isFinite(secondPid) && secondPid > 0);
    assert.notEqual(secondPid, firstPid);

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth kills the daemon from daemon.state.json when daemon stop is a no-op', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const { cliCommand } = await writePathResolvedRuntimeCommand({ binDir, stopMode: 'noop' });

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    const statePath = join(cliHomeDir, 'daemon.state.json');

    const env = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const firstPid = await readDaemonPid(statePath);

    await startLocalDaemonWithAuth({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const secondPid = await readDaemonPid(statePath);

    assert.notEqual(secondPid, firstPid);
    assert.doesNotThrow(() => process.kill(secondPid, 0));
    assert.throws(() => process.kill(firstPid, 0));

    await stopLocalDaemon({
      cliBin: join(tmp, 'runtime', 'cli', 'happier'),
      cliCommand,
      internalServerUrl,
      cliHomeDir,
      env,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('cancelled Stack restart preserves a concurrently published successor lock and state byte-for-byte', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-successor-publication-'));
  const successor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    env: { PATH: process.env.PATH ?? '' },
    stdio: 'ignore',
  });
  successor.unref();
  try {
    const { internalServerUrl, publicServerUrl } = await reserveLoopbackServerUrls();
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const binDir = join(tmp, 'bin');
    const cliCommand = 'happier-successor-publication-fixture';
    const commandPath = join(binDir, cliCommand);
    const serverSetHelperPath = join(binDir, 'happier-successor-server-set.mjs');
    const lsofPath = join(binDir, 'lsof');
    const startAttemptMarker = join(tmp, 'start-attempted');
    await mkdir(binDir, { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const baseEnv = buildDaemonDistGuardEnv({
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_TUI: '0',
      // Cancellation is signaled by the start marker; keep preflight on the
      // canonical startup budget rather than racing its OS process scheduling.
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: String(DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS),
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });
    const daemonEnv = await getDaemonEnv({
      baseEnv,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      stackName: 'dev',
      cliIdentity: 'default',
    });
    const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
    });
    const successorStateRaw = `${JSON.stringify({
      pid: successor.pid,
      httpPort: 65534,
      startedAt: 7_777,
      startedWithCliVersion: '0.0.0-successor',
      controlToken: 'successor-control-token',
    }, null, 2)}\n`;
    const successorLockRaw = `${JSON.stringify({
      t: 'happier_daemon_lock_v1',
      pid: successor.pid,
      ownerToken: '00000000-0000-4000-8000-000000000001',
      processStartedAtMs: 7_777,
      createdAtMs: 7_777,
    })}\n`;
    await writeFile(
      serverSetHelperPath,
      `const args = process.argv.slice(2);\n${buildStubHappierServerSetSource()}\n`,
      'utf-8',
    );
    await writeFile(commandPath, `#!/bin/sh
case "$1:$2" in
  server:set)
    exec "${process.execPath}" "${serverSetHelperPath}" "$@"
    ;;
  daemon:stop)
    mkdir -p "$(dirname "$HAPPIER_TEST_SUCCESSOR_STATE_PATH")"
    printf '%s' "$HAPPIER_TEST_SUCCESSOR_STATE_RAW" > "$HAPPIER_TEST_SUCCESSOR_STATE_PATH"
    printf '%s' "$HAPPIER_TEST_SUCCESSOR_LOCK_RAW" > "$HAPPIER_TEST_SUCCESSOR_LOCK_PATH"
    exit 0
    ;;
  daemon:start)
    printf 'attempted' > "$HAPPIER_TEST_START_ATTEMPT_MARKER"
    exit 47
    ;;
  *)
    exit 1
    ;;
esac
`, 'utf-8');
    await chmod(commandPath, 0o755);
    await writeFile(lsofPath, '#!/bin/sh\nprintf "COMMAND PID USER FD TYPE NAME\\nfixture 1 user 1r REG /unrelated\\n"\n', 'utf-8');
    await chmod(lsofPath, 0o755);

    await assert.rejects(
      () => startLocalDaemonWithAuth({
        cliBin: join(tmp, 'runtime', 'cli', 'happier'),
        cliCommand,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        // The foreign successor stays alive; explicitly cancel this failed
        // attempt instead of treating a readiness checkpoint as terminal.
        isShuttingDown: () => existsSync(startAttemptMarker),
        forceRestart: true,
        env: {
          ...baseEnv,
          HAPPIER_TEST_SUCCESSOR_STATE_PATH: statePath,
          HAPPIER_TEST_SUCCESSOR_LOCK_PATH: lockPath,
          HAPPIER_TEST_SUCCESSOR_STATE_RAW: successorStateRaw,
          HAPPIER_TEST_SUCCESSOR_LOCK_RAW: successorLockRaw,
          HAPPIER_TEST_START_ATTEMPT_MARKER: startAttemptMarker,
        },
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /Failed to start daemon/,
    );

    assert.equal(await readFile(statePath, 'utf-8'), successorStateRaw);
    assert.equal(await readFile(lockPath, 'utf-8'), successorLockRaw);
  } finally {
    try {
      process.kill(successor.pid, 'SIGKILL');
    } catch {
      // already exited
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
