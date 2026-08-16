import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createHappyCliReloadDescriptors,
  createHappyCliReloadExecutor,
  startDevDaemon,
} from './daemon.mjs';
import { syncStackRuntimeDaemonPidFromDaemonState } from '../stack/runtime_daemon_state.mjs';

async function writeDistBuildManifest(distIndexPath, fingerprint = 'abc123def4567890') {
  await writeFile(
    join(dirname(distIndexPath), '.build-manifest.json'),
    JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 1,
      toolVersion: '1',
    }) + '\n',
    'utf-8',
  );
}

test('CLI reload descriptors share the scoped runtime inventory and exclude generated refresh outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-cli-inputs-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const agentsDir = join(root, 'packages', 'agents');
  const cliCommonDir = join(root, 'packages', 'cli-common');
  const connectionSupervisorDir = join(root, 'packages', 'connection-supervisor');
  const protocolDir = join(root, 'packages', 'protocol');
  const releaseRuntimeDir = join(root, 'packages', 'release-runtime');
  const transfersDir = join(root, 'packages', 'transfers');
  for (const path of [
    join(cliDir, 'src'),
    join(cliDir, 'src', 'agent', 'tools', 'trace'),
    join(cliDir, 'bin'),
    join(cliDir, 'codex'),
    join(cliDir, 'scripts'),
    join(agentsDir, 'src'),
    join(agentsDir, 'scripts'),
    join(cliCommonDir, 'src'),
    join(connectionSupervisorDir, 'src'),
    join(protocolDir, 'src'),
    join(releaseRuntimeDir, 'src'),
    join(transfersDir, 'src'),
    join(root, 'scripts', 'workspaces'),
    join(root, 'apps', 'ui', 'src'),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(
    join(cliDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/cli',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/cli-common': '0.0.0',
        '@happier-dev/connection-supervisor': '0.0.0',
        '@happier-dev/protocol': '0.0.0',
        '@happier-dev/release-runtime': '0.0.0',
        '@happier-dev/transfers': '0.0.0',
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(
    join(agentsDir, 'package.json'),
    JSON.stringify({ name: '@happier-dev/agents', dependencies: { '@happier-dev/protocol': '0.0.0' } }) + '\n',
    'utf-8',
  );
  await writeFile(
    join(cliCommonDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/cli-common',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/protocol': '0.0.0',
        '@happier-dev/release-runtime': '0.0.0',
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(
    join(connectionSupervisorDir, 'package.json'),
    '{"name":"@happier-dev/connection-supervisor"}\n',
    'utf-8',
  );
  await writeFile(join(protocolDir, 'package.json'), '{"name":"@happier-dev/protocol"}\n', 'utf-8');
  await writeFile(join(releaseRuntimeDir, 'package.json'), '{"name":"@happier-dev/release-runtime"}\n', 'utf-8');
  await writeFile(
    join(transfersDir, 'package.json'),
    '{"name":"@happier-dev/transfers","dependencies":{"@happier-dev/protocol":"0.0.0"}}\n',
    'utf-8',
  );
  for (const path of [
    join(cliDir, 'tsconfig.json'),
    join(cliDir, 'tsconfig.build.json'),
    join(cliDir, 'pkgroll.config.mjs'),
    join(agentsDir, 'tsconfig.json'),
    join(agentsDir, 'tsconfig.build.json'),
    join(cliCommonDir, 'tsconfig.json'),
    join(connectionSupervisorDir, 'tsconfig.json'),
    join(protocolDir, 'tsconfig.json'),
    join(releaseRuntimeDir, 'tsconfig.json'),
    join(transfersDir, 'tsconfig.json'),
    join(root, 'package.json'),
    join(root, 'yarn.lock'),
  ]) {
    await writeFile(path, '{}\n', 'utf-8');
  }
  await writeFile(join(cliDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(agentsDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(cliCommonDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(connectionSupervisorDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(protocolDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(releaseRuntimeDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(transfersDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  await writeFile(join(agentsDir, 'scripts', 'release-only.mjs'), 'export {};\n', 'utf-8');

  const descriptors = createHappyCliReloadDescriptors({ cliDir, logger: { warn() {} } });
  const paths = descriptors.flatMap((descriptor) => descriptor.paths);
  const targetsById = new Map(descriptors.map(({ id, target }) => [id, target]));
  assert.equal(targetsById.get('shared:agents'), 'shared');
  assert.equal(targetsById.get('shared:cli-common'), 'shared');
  assert.equal(targetsById.get('shared:protocol'), 'shared');
  assert.equal(targetsById.get('daemon:connection-supervisor'), 'daemon');
  assert.equal(targetsById.get('daemon:release-runtime'), 'daemon');
  assert.equal(targetsById.get('daemon:transfers'), 'daemon');
  assert.ok(
    descriptors.every((descriptor) => typeof descriptor.readSignatureAsync === 'function'),
    'runtime descriptors must keep recursive signature reads off the lifecycle event loop',
  );
  assert.ok(paths.includes(join(agentsDir, 'src')));
  assert.ok(paths.includes(join(agentsDir, 'tsconfig.build.json')));
  assert.ok(paths.includes(join(protocolDir, 'src')), 'recursive runtime workspace dependencies must be included');
  assert.ok(paths.includes(join(cliDir, 'pkgroll.config.mjs')));
  assert.ok(!paths.includes(join(agentsDir, 'scripts')), 'workspace release/build scripts are not runtime inputs');
  assert.ok(!paths.some((path) => path.includes('/dist') || path.includes('/node_modules')));

  const before = descriptors.map((descriptor) => descriptor.readSignature());
  const assertIgnoredFileLifecycle = async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'export const testOnly = 1;\n', 'utf-8');
    assert.deepEqual(descriptors.map((descriptor) => descriptor.readSignature()), before, `adding ${path} must be ignored`);
    await writeFile(path, 'export const testOnly = 2;\n', 'utf-8');
    assert.deepEqual(descriptors.map((descriptor) => descriptor.readSignature()), before, `editing ${path} must be ignored`);
    await rm(path, { force: true });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.readSignature()), before, `deleting ${path} must be ignored`);
  };
  await assertIgnoredFileLifecycle(join(cliDir, 'src', 'testkit', 'nested', 'runtimeFixture.ts'));
  await assertIgnoredFileLifecycle(join(cliDir, 'src', 'agent', 'tools', 'trace', 'runtimeFixture.testkit.ts'));
  await assertIgnoredFileLifecycle(join(cliDir, 'src', 'vitestSetup.ts'));
  await assertIgnoredFileLifecycle(join(cliDir, 'src', 'runtime.test.ts'));
  const assertRuntimeFileLifecycle = async (path) => {
    await writeFile(path, 'export const runtimeValue = 1;\n', 'utf-8');
    const added = descriptors.map((descriptor) => descriptor.readSignature());
    assert.notDeepEqual(added, before, `adding ${path} must change the runtime signature`);
    await writeFile(path, 'export const runtimeValue = 200;\n', 'utf-8');
    const edited = descriptors.map((descriptor) => descriptor.readSignature());
    assert.notDeepEqual(edited, added, `editing ${path} must change the runtime signature`);
    await rm(path, { force: true });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.readSignature()), before, `deleting ${path} must restore the runtime signature`);
  };
  await assertRuntimeFileLifecycle(join(cliDir, 'src', 'runtime-testkit.ts'));
  await assertRuntimeFileLifecycle(join(cliDir, 'src', 'runtime_testkit.ts'));
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export const generated = true;\n', 'utf-8');
  await writeFile(join(root, 'node_modules', '.happier-stack-dependencies-ready'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'ui', 'src', 'unrelated.ts'), 'export {};\n', 'utf-8');
  const after = descriptors.map((descriptor) => descriptor.readSignature());
  assert.deepEqual(after, before, 'build outputs, dependency markers, and unrelated UI must not self-trigger CLI reload');

  await writeFile(join(cliDir, 'src', 'index.ts'), 'export const runtime = true;\n', 'utf-8');
  assert.notDeepEqual(
    descriptors.map((descriptor) => descriptor.readSignature()),
    before,
    'runtime CLI source changes must trigger daemon reload',
  );
});

test('startDevDaemon forwards stack context to daemon startup', async () => {
  let capturedArgs = null;

  await startDevDaemon(
    {
      startDaemon: true,
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      restart: true,
      startLastGreen: true,
      isShuttingDown: () => false,
      env: { TEST_ENV: '1' },
      stackName: 'dev',
      cliIdentity: 'reviewer',
    },
    {
      startLocalDaemonWithAuthImpl: async (args) => {
        capturedArgs = args;
      },
    }
  );

  assert.ok(capturedArgs);
  assert.equal(capturedArgs.forceRestart, true);
  assert.equal(capturedArgs.admitPriorDistImmediately, true);
  assert.equal(capturedArgs.stackName, 'dev');
  assert.equal(capturedArgs.cliIdentity, 'reviewer');
  assert.equal(capturedArgs.env?.TEST_ENV, '1');
});

test('startDevDaemon defers a failed last-green launch to the watch reload coordinator', async () => {
  const warnings = [];
  const result = await startDevDaemon(
    {
      startDaemon: true,
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      restart: false,
      startLastGreen: true,
      isShuttingDown: () => false,
      stackName: 'remote-dev',
    },
    {
      startLocalDaemonWithAuthImpl: async () => {
        throw new Error('prior publication cannot start');
      },
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  assert.deepEqual(result, {
    started: false,
    reason: 'prior-dist-start-failed',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /background rebuild/i);
});

test('startDevDaemon preserves a failed non-watch launch as a startup error', async () => {
  await assert.rejects(
    () => startDevDaemon(
      {
        startDaemon: true,
        cliBin: '/tmp/happy-cli/bin/happier.mjs',
        cliHomeDir: '/tmp/happy-cli-home',
        internalServerUrl: 'http://127.0.0.1:3009',
        publicServerUrl: 'http://localhost:3009',
        restart: false,
        startLastGreen: false,
        isShuttingDown: () => false,
        stackName: 'remote-dev',
      },
      {
        startLocalDaemonWithAuthImpl: async () => {
          throw new Error('current publication cannot start');
        },
      },
    ),
    /current publication cannot start/,
  );
});

test('reload executor rejects bare dist entrypoint without build manifest', async () => {
  const cliDir = '/tmp/repo/apps/cli';
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: `${cliDir}/bin/happier.mjs`,
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      existsSyncImpl: (path) => String(path).endsWith('/dist/index.mjs'),
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await assert.rejects(() => executor.build(), /build manifest/);
});

test('reload executor restarts from an already-current dist and preserves the stack build environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-current-dist-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  const env = { HAPPIER_STACK_CLI_BUILD_MODE: 'auto', STACK_TOKEN: 'preserved' };
  let capturedBuildOptions = null;
  let restartCalls = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      env,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async (_cliDir, options) => {
        capturedBuildOptions = options;
        return { built: false, current: true, reason: 'cache_hit' };
      },
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), { ok: true });
  assert.equal(capturedBuildOptions?.env, env);
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });
  assert.equal(restartCalls, 1, 'a watcher generation must not be consumed without activating the current dist');
});

test('reload executor coalesces consecutive current and superseded generations already active in the healthy daemon', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-same-dist-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  const env = { HAPPIER_STACK_CLI_BUILD_MODE: 'auto', STACK_TOKEN: 'preserved' };
  const buildResults = [
    { built: false, current: true, reason: 'cache_hit' },
    { built: true, current: false, reason: 'inputs_changed_during_build' },
    { built: false, current: true, reason: 'cache_hit' },
  ];
  const runtimeState = {
    processes: { daemonPid: 111, daemonPids: [111] },
    daemon: { distClosureFingerprint: 'abcdef1234567890' },
  };
  let pingPid = 111;
  let restartCalls = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: join(root, 'stack.runtime.json'),
      isShuttingDown: () => false,
      env,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => buildResults.shift(),
      pingDaemonImpl: async () => ({
        ok: true,
        pid: pingPid,
        distClosureFingerprint: 'abcdef1234567890',
      }),
      readStackRuntimeStateFileImpl: async () => runtimeState,
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
        return { status: 'already_restarting', previousPid: 111, pid: 222 };
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), { ok: true });
  assert.deepEqual(
    await executor.restart({ revalidateGeneration: async () => true }),
    { skipped: true, reason: 'daemon-dist-already-active' },
  );

  assert.deepEqual(await executor.build(), {
    ok: true,
    allowSupersededActivation: true,
  });
  assert.deepEqual(
    await executor.restart({ revalidateGeneration: async () => false }),
    { skipped: true, reason: 'daemon-dist-already-active' },
  );
  assert.equal(restartCalls, 0, 'same-fingerprint generations must not request a replacement daemon');

  pingPid = 222;
  assert.deepEqual(await executor.build(), { ok: true });
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });
  assert.equal(restartCalls, 1, 'an unprojected same-fingerprint activation must remain unresolved');
});

test('reload executor retries lock contention and activates the concurrently published CLI build even after newer edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-lock-adoption-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  let buildCalls = 0;
  let restartCalls = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        if (buildCalls === 1) {
          const error = new Error('Timed out waiting for CLI dist build lock');
          error.code = 'EWORKSPACEBUNDLELOCKTIMEOUT';
          throw error;
        }
        return {
          built: false,
          current: false,
          reason: 'concurrent_build_superseded',
        };
      },
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(
    await executor.build({ revalidateGeneration: async () => true }),
    { ok: true, allowSupersededActivation: true },
  );
  assert.equal(buildCalls, 2);
  assert.deepEqual(
    await executor.restart({ revalidateGeneration: async () => false }),
    { restarted: true, mode: 'overlap' },
  );
  assert.equal(restartCalls, 1);
});

test('reload executor cold-starts an absent daemon from a runnable superseded publication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-superseded-cold-start-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  const starts = [];
  const warnings = [];
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({
        built: true,
        current: false,
        reason: 'inputs_changed_during_build',
      }),
      pingDaemonImpl: async () => ({ ok: false, reason: 'daemon_not_running' }),
      startLocalDaemonWithAuthImpl: async (args) => {
        starts.push(args);
      },
      logger: { log() {}, warn(message) { warnings.push(String(message)); }, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), {
    ok: true,
    allowSupersededActivation: true,
  });
  assert.deepEqual(
    await executor.restart({ revalidateGeneration: async () => false }),
    { restarted: true, mode: 'cold-start', degraded: true },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].admittedDistClosureFingerprint, 'abcdef1234567890');
  assert.ok(warnings.some((message) => /superseded.*degraded/i.test(message)));
});

test('reload executor activates a successful superseded publication over a healthy incumbent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-superseded-incumbent-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  let replacementCalls = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({
        built: true,
        current: false,
        reason: 'inputs_changed_during_build',
      }),
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        replacementCalls += 1;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), {
    ok: true,
    allowSupersededActivation: true,
  });
  assert.deepEqual(
    await executor.restart({ revalidateGeneration: async () => false }),
    { restarted: true, mode: 'overlap' },
  );
  assert.equal(replacementCalls, 1);
});

test('reload executor persists the authenticated overlap successor for new and already-running restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-fingerprint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  for (const restartStatus of ['restarting', 'already_restarting']) {
    const runtimeStatePath = join(root, `${restartStatus}.runtime.json`);
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName: 'dev',
        processes: { serverPid: 999, daemonPid: 111, daemonPids: [111] },
        daemon: { distClosureFingerprint: '0000000000000000' },
      }) + '\n',
      'utf-8',
    );

    let restartFingerprint = null;
    const executor = createHappyCliReloadExecutor(
      {
        startDaemon: true,
        buildCli: true,
        cliDir,
        cliBin: join(cliDir, 'bin', 'happier.mjs'),
        cliHomeDir: join(root, 'home'),
        internalServerUrl: 'http://127.0.0.1:3009',
        publicServerUrl: 'http://localhost:3009',
        runtimeStatePath,
        isShuttingDown: () => false,
        stackName: 'dev',
      },
      {
        ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
        pingDaemonImpl: async () => ({
          ok: true,
          pid: 111,
          distClosureFingerprint: '0000000000000000',
        }),
        restartDaemonViaControlServerImpl: async (args) => {
          restartFingerprint = args.successorDistClosureFingerprint;
          return { status: restartStatus, previousPid: 111, pid: 222 };
        },
        syncStackRuntimeDaemonPidFromDaemonStateImpl: async (args, options) =>
          await syncStackRuntimeDaemonPidFromDaemonState(args, {
            ...options,
            isPidAliveImpl: (pid) => pid === 111 || pid === 222,
            resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'test_owned' }),
          }),
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await executor.build();
    assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });

    assert.equal(restartFingerprint, 'abcdef1234567890');
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(runtimeState.processes.serverPid, 999);
    assert.equal(runtimeState.processes.daemonPid, 222);
    assert.equal(runtimeState.daemon.distClosureFingerprint, 'abcdef1234567890');
  }
});

test('reload executor does not sync runtime state when overlap confirmation fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-no-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  let syncCalls = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: join(root, 'failed.runtime.json'),
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        throw new Error('successor_fingerprint_mismatch');
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async () => {
        syncCalls += 1;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await executor.build();
  await assert.rejects(() => executor.restart(), /successor_fingerprint_mismatch/);
  assert.equal(syncCalls, 0);
});

test('reload executor awaits a stale source generation after control ping before overlap activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-generation-fence-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  let releasePing;
  const pingBlocked = new Promise((resolve) => {
    releasePing = resolve;
  });
  let notifyPingStarted;
  const pingStarted = new Promise((resolve) => {
    notifyPingStarted = resolve;
  });
  let restartCalls = 0;
  let releaseRevalidation;
  const revalidationBlocked = new Promise((resolve) => {
    releaseRevalidation = resolve;
  });
  let notifyRevalidationStarted;
  const revalidationStarted = new Promise((resolve) => {
    notifyRevalidationStarted = resolve;
  });
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: join(root, 'stack.runtime.json'),
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: false, current: true, reason: 'cache_hit' }),
      pingDaemonImpl: async () => {
        notifyPingStarted();
        await pingBlocked;
        return { ok: true, pid: 111, distClosureFingerprint: '0000000000000000' };
      },
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await executor.build();
  const restart = executor.restart({
    revalidateGeneration: async () => {
      notifyRevalidationStarted();
      await revalidationBlocked;
      return false;
    },
  });
  await pingStarted;
  releasePing();
  await revalidationStarted;
  assert.equal(restartCalls, 0, 'control restart must wait for generation revalidation');
  releaseRevalidation();

  assert.deepEqual(await restart, { skipped: true, reason: 'stale-generation' });
  assert.equal(restartCalls, 0, 'a stale generation must not reach the irreversible control restart');
});

test('reload executor awaits a stale source generation before cold-start activation', async () => {
  let coldStarts = 0;
  let releaseRevalidation;
  const revalidationBlocked = new Promise((resolve) => {
    releaseRevalidation = resolve;
  });
  let notifyRevalidationStarted;
  const revalidationStarted = new Promise((resolve) => {
    notifyRevalidationStarted = resolve;
  });
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/repo/home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      pingDaemonImpl: async () => ({ ok: false, reason: 'daemon_not_running' }),
      startLocalDaemonWithAuthImpl: async () => {
        coldStarts += 1;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  const restart = executor.restart({
    revalidateGeneration: async () => {
      notifyRevalidationStarted();
      await revalidationBlocked;
      return false;
    },
  });
  await revalidationStarted;
  assert.equal(coldStarts, 0, 'cold start must wait for generation revalidation');
  releaseRevalidation();

  assert.deepEqual(
    await restart,
    { skipped: true, reason: 'stale-generation' },
  );
  assert.equal(coldStarts, 0, 'a stale generation must not reach cold-start activation');
});

test('reload executor cold-start carries the admitted build fingerprint into daemon generation admission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-cold-start-admission-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  let coldStartArgs = null;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      env: { HAPPIER_STACK_CLI_BUILD_MODE: 'always' },
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'always' }),
      pingDaemonImpl: async () => ({ ok: false, reason: 'daemon_not_running' }),
      startLocalDaemonWithAuthImpl: async (args) => {
        coldStartArgs = args;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), { ok: true, allowSupersededActivation: true });
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'cold-start' });
  assert.equal(coldStartArgs?.admittedDistClosureFingerprint, 'abcdef1234567890');
});

test('successful CLI publication waits for a live startup daemon to publish its control state before activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-control-state-race-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  await writeDistBuildManifest(distIndexPath, 'abcdef1234567890');

  let pingCalls = 0;
  let restartCalls = 0;
  const delays = [];
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: join(root, 'stack.runtime.json'),
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
      pingDaemonImpl: async () => {
        pingCalls += 1;
        return pingCalls === 1
          ? { ok: false, reason: 'missing_state' }
          : { ok: true, pid: 111 };
      },
      readStackRuntimeStateFileImpl: async () => ({ processes: { daemonPid: 111 } }),
      isPidAliveImpl: (pid) => pid === 111,
      sleepImpl: async (delayMs) => { delays.push(delayMs); },
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await executor.build();
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });
  assert.equal(pingCalls, 2);
  assert.equal(restartCalls, 1);
  assert.equal(delays.length, 1);
});
