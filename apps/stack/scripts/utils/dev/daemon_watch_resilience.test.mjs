import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createHappyCliReloadDescriptors,
  createHappyCliReloadExecutor,
  createHappyCliWorkspacePreparationExecutor,
  startDevDaemon,
} from './daemon.mjs';
import { createDevServerReloadDescriptors } from './server.mjs';
import cliDistBuildManifest from '../cli/cliDistBuildManifestLoader.mjs';

function writeDistBuildManifestForTest(distIndexPath, options = {}) {
  return cliDistBuildManifest.writeCliDistBuildManifest(distIndexPath, {
    outputDir: dirname(distIndexPath),
    builtAt: '2026-07-09T00:00:00.000Z',
    ...options,
  });
}

test('CLI reload descriptors own source inputs and exclude generated refresh outputs', async (t) => {
  const lexicalRoot = await mkdtemp(join(tmpdir(), 'hs-daemon-cli-inputs-'));
  const root = await realpath(lexicalRoot);
  t.after(async () => rm(lexicalRoot, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const runtimePackages = [
    { id: 'agents', dir: join(root, 'packages', 'agents') },
    { id: 'plugin-sdk', dir: join(root, 'packages', 'plugin-sdk') },
    { id: 'plugins-codex', dir: join(root, 'packages', 'plugins', 'codex') },
    { id: 'protocol', dir: join(root, 'packages', 'protocol') },
    { id: 'transfers', dir: join(root, 'packages', 'transfers') },
  ];
  for (const path of [
    join(cliDir, 'src'),
    join(cliDir, 'bin'),
    join(cliDir, 'codex'),
    join(cliDir, 'scripts'),
    join(root, 'scripts', 'workspaces'),
    ...runtimePackages.map(({ dir }) => join(dir, 'src')),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    bundledDependencies: [
      '@happier-dev/agents',
      '@happier-dev/plugin-sdk',
      '@happier-dev/plugins-codex',
      '@happier-dev/protocol',
      '@happier-dev/transfers',
    ],
    dependencies: {
      '@happier-dev/agents': '0.0.0',
      '@happier-dev/plugin-sdk': '0.0.0',
      '@happier-dev/plugins-codex': '0.0.0',
    },
  }), 'utf-8');
  await writeFile(join(root, 'packages', 'agents', 'package.json'), JSON.stringify({
    name: '@happier-dev/agents',
    dependencies: { '@happier-dev/protocol': '0.0.0' },
  }), 'utf-8');
  await writeFile(join(root, 'packages', 'plugin-sdk', 'package.json'), JSON.stringify({
    name: '@happier-dev/plugin-sdk',
    dependencies: { '@happier-dev/transfers': '0.0.0' },
  }), 'utf-8');
  await writeFile(join(root, 'packages', 'plugins', 'codex', 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-codex',
  }), 'utf-8');
  for (const name of ['protocol', 'transfers']) {
    await writeFile(join(root, 'packages', name, 'package.json'), JSON.stringify({
      name: `@happier-dev/${name}`,
    }), 'utf-8');
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['apps/*', 'packages/*', 'packages/plugins/[a-z]*'],
  }), 'utf-8');
  for (const path of [
    join(cliDir, 'tsconfig.json'),
    join(cliDir, 'tsconfig.build.json'),
    join(cliDir, 'pkgroll.config.mjs'),
    ...runtimePackages.flatMap(({ dir }) => [
      join(dir, 'tsconfig.json'),
      join(dir, 'tsconfig.build.json'),
    ]),
  ]) {
    await writeFile(path, '{}\n', 'utf-8');
  }
  await writeFile(join(root, 'yarn.lock'), '# workspace build input\n', 'utf-8');
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');

  const descriptors = createHappyCliReloadDescriptors({ cliDir });
  const paths = descriptors.flatMap((descriptor) => descriptor.paths);
  assert.ok(paths.includes(join(cliDir, 'src')));
  assert.ok(paths.includes(join(cliDir, 'scripts')));
  assert.ok(paths.includes(join(root, 'packages', 'agents', 'src')));
  assert.ok(paths.includes(join(root, 'packages', 'plugin-sdk', 'src')));
  assert.ok(paths.includes(join(root, 'packages', 'plugins', 'codex', 'src')));
  assert.ok(paths.includes(join(root, 'packages', 'protocol', 'src')));
  assert.ok(paths.includes(join(root, 'packages', 'transfers', 'src')));
  assert.ok(paths.includes(join(root, 'scripts', 'workspaces')));
  assert.ok(paths.includes(join(root, 'package.json')));
  assert.ok(paths.includes(join(root, 'yarn.lock')));
  assert.equal(descriptors.find((descriptor) => descriptor.id === 'shared:plugin-sdk')?.target, 'daemon');
  const serverDescriptors = createDevServerReloadDescriptors({ serverDir: join(root, 'apps', 'server') });
  assert.equal(descriptors.find((descriptor) => descriptor.id === 'shared:agents')?.target, 'daemon');
  assert.equal(serverDescriptors.find((descriptor) => descriptor.id === 'shared:agents')?.target, 'shared');
  assert.equal(serverDescriptors.some((descriptor) => descriptor.id === 'shared:plugin-sdk'), false);
  assert.deepEqual(
    descriptors.find((descriptor) => descriptor.id === 'daemon:cli-publication')?.paths,
    [join(cliDir, 'dist', '.build-manifest.json')],
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === 'daemon:cli-publication')?.invalidatesGeneration,
    false,
  );
  assert.ok(!paths.some((path) => path.includes('/node_modules')));
  assert.ok(!paths.some((path) => path.includes('/dist') && !path.endsWith('/dist/.build-manifest.json')));
});

test('workspace preparation executor refreshes generated plugin inputs without owning daemon lifecycle', async () => {
  const calls = [];
  const executor = createHappyCliWorkspacePreparationExecutor(
    {
      repoRoot: '/repo',
      cliDir: '/repo/apps/cli',
      env: { HAPPIER_STACK_STACK: 'repo-dev' },
    },
    {
      syncSharedDepsForSourceDevImpl: async (repoRoot, options) => {
        calls.push({ repoRoot, options });
        return { synced: true, reason: 'completed' };
      },
    },
  );

  assert.deepEqual(await executor.build(), { synced: true, reason: 'completed' });
  assert.deepEqual(await executor.restart(), { skipped: true, reason: 'preparation-only' });
  assert.deepEqual(calls, [{
    repoRoot: '/repo',
    options: {
      cliDir: '/repo/apps/cli',
      env: { HAPPIER_STACK_STACK: 'repo-dev' },
      quiet: true,
    },
  }]);
});

test('reload executor immediately adopts an external superseded CLI publication before requesting the trailing build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-external-publication-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  const publishedInputFingerprint = 'a'.repeat(64);
  const currentInputFingerprint = 'b'.repeat(64);
  writeDistBuildManifestForTest(distIndexPath, {
    inputFingerprint: publishedInputFingerprint,
  });

  let ensureBuildCalls = 0;
  let runtimeProbeCalls = 0;
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
        ensureBuildCalls += 1;
        return { built: true, current: true, reason: 'unexpected' };
      },
      readCliRuntimeInputFreshnessImpl: async () => ({
        fingerprint: currentInputFingerprint,
        newestMtimeNs: 2n,
      }),
      probeCliDistRuntimeImportImpl: async () => {
        runtimeProbeCalls += 1;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build({
    changedDescriptors: ['daemon:cli-publication'],
  }), {
    ok: true,
    allowSupersededActivation: true,
    requestFollowup: true,
  });
  assert.equal(ensureBuildCalls, 0);
  assert.equal(runtimeProbeCalls, 1);
});

test('reload executor builds a successor when an external publication workspace payload is unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-external-workspace-unavailable-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  const workspaceRuntimeIdentity = 'a'.repeat(64);
  writeDistBuildManifestForTest(distIndexPath, {
    inputFingerprint: 'b'.repeat(64),
    workspaceRuntimeIdentity,
    workspaceRuntimePackages: ['@happier-dev/protocol'],
  });

  let buildCompleted = false;
  let ensureBuildCalls = 0;
  let coldStartCalls = 0;
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
        ensureBuildCalls += 1;
        buildCompleted = true;
        return { built: true, current: true, reason: 'test' };
      },
      readCliRuntimeInputFreshnessImpl: async () => ({
        fingerprint: 'c'.repeat(64),
        newestMtimeNs: 2n,
      }),
      readCliWorkspaceRuntimeIdentityImpl: () => {
        if (!buildCompleted) throw new Error('workspace payload is absent');
        return {
          fingerprint: workspaceRuntimeIdentity,
          packageCount: 1,
          packageNames: ['@happier-dev/protocol'],
        };
      },
      pingDaemonImpl: async () => ({ ok: false, reason: 'daemon_not_running' }),
      startLocalDaemonWithAuthImpl: async () => {
        coldStartCalls += 1;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build({
    changedDescriptors: ['daemon:cli-publication'],
  }), {
    skipped: true,
    reason: 'cli-publication-workspace-runtime-unavailable',
    requestFollowup: true,
  });
  assert.equal(ensureBuildCalls, 0);

  assert.deepEqual(await executor.build({ changedDescriptors: [] }), {
    ok: true,
    allowSupersededActivation: true,
  });
  assert.equal(ensureBuildCalls, 1);
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'cold-start' });
  assert.equal(coldStartCalls, 1);
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
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
      existsSyncImpl: (path) => String(path).endsWith('/dist/index.mjs'),
      logger: { log() {}, warn() {}, error() {} },
    },
  );
  await assert.rejects(() => executor.build(), /build manifest/);
});

test('reload executor marks only captured canonical mixed-input CLI build rejections as retryable', async () => {
  const cliDir = '/tmp/repo/apps/cli';
  const buildErrors = [
    Object.assign(new Error(
      'yarn failed (code=1, sig=null)\n\nChild output:\n[stderr]\n' +
        '[cli-build-inputs] runtime inputs changed while this build was running; ' +
        'refusing to finalize a mixed CLI closure',
    ), { code: 'EEXIT' }),
    Object.assign(new Error(
      'yarn failed (code=1, sig=null)\n\nChild output:\n[stderr]\n' +
        '[cli-build-inputs] runtime inputs changed while package prebuild was preparing dependencies; ' +
        'refusing to build a mixed CLI closure',
    ), { code: 'EEXIT' }),
    Object.assign(new Error(
      'yarn failed (code=1, sig=null)\n\nChild output:\n[stderr]\nTypeScript compilation failed',
    ), { code: 'EEXIT' }),
  ];
  const buildOptions = [];
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
      ensureCliBuiltImpl: async (_cliDir, options) => {
        buildOptions.push(options);
        throw buildErrors.shift();
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await assert.rejects(
    () => executor.build(),
    (error) => error?.reloadRetryAfterMs === 250,
  );
  await assert.rejects(
    () => executor.build(),
    (error) => error?.reloadRetryAfterMs === 250,
  );
  await assert.rejects(
    () => executor.build(),
    (error) => error?.reloadRetryAfterMs === undefined,
  );
  assert.deepEqual(buildOptions, [
    { buildCli: true, env: process.env, quiet: true },
    { buildCli: true, env: process.env, quiet: true },
    { buildCli: true, env: process.env, quiet: true },
  ]);
});

test('startDevDaemon delegates CLI readiness to the final daemon launch boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-start-ready-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export {};\n', 'utf-8');
  await writeDistBuildManifestForTest(distIndexPath);

  let capturedArgs = null;
  const events = [];
  await startDevDaemon(
    {
      startDaemon: true,
      cliDir,
      buildCli: true,
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
      ensureDepsInstalledImpl: async () => { throw new Error('duplicate dependency admission'); },
      ensureCliBuiltImpl: async () => { throw new Error('duplicate CLI build admission'); },
      startLocalDaemonWithAuthImpl: async (args) => {
        events.push('daemon-started');
        capturedArgs = args;
      },
    },
  );
  assert.deepEqual(events, ['daemon-started']);
  assert.equal(capturedArgs.forceRestart, true);
  assert.equal(capturedArgs.admitPriorDistImmediately, true);
  assert.equal(capturedArgs.stackName, 'dev');
  assert.equal(capturedArgs.cliIdentity, 'reviewer');
  assert.equal(capturedArgs.env.TEST_ENV, '1');
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
      stackName: 'dev',
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

test('startDevDaemon preserves a replacement that became live while lifecycle recovery waited', async () => {
  let capturedArgs = null;
  await startDevDaemon(
    {
      startDaemon: true,
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      restart: false,
      startLastGreen: true,
      preserveExistingRunning: true,
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      startLocalDaemonWithAuthImpl: async (args) => {
        capturedArgs = args;
      },
    },
  );

  assert.equal(capturedArgs.preserveExistingRunning, true);
  assert.equal(capturedArgs.forceRestart, false);
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
        stackName: 'dev',
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

test('startDevDaemon keeps an interactive TUI server running when initial daemon startup fails', async () => {
  const warnings = [];
  const result = await startDevDaemon(
    {
      startDaemon: true,
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      restart: false,
      startLastGreen: false,
      keepServerRunningOnFailure: true,
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      startLocalDaemonWithAuthImpl: async () => {
        throw new Error('daemon credentials were rejected');
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
    reason: 'daemon-start-failed',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeping the TUI server running/i);
  assert.match(warnings[0], /daemon credentials were rejected/i);
});

test('reload executor skips replacement when the CLI build result is not current', async () => {
  let restartCalls = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: false,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: false, current: false, reason: 'mode_never' }),
      existsSyncImpl: () => true,
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => { restartCalls += 1; },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), {
    skipped: true,
    reason: 'cli-build-mode_never',
  });
  assert.equal(restartCalls, 0);
});

test('reload executor coalesces consecutive current and superseded generations already active in the healthy daemon', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-same-dist-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  const { manifest } = writeDistBuildManifestForTest(distIndexPath);

  const buildResults = [
    { built: false, current: true, reason: 'cache_hit' },
    { built: true, current: false, reason: 'inputs_changed_during_build' },
    { built: false, current: true, reason: 'cache_hit' },
  ];
  const runtimeState = {
    processes: { daemonPid: 111, daemonPids: [111] },
    daemon: { distClosureFingerprint: manifest.fingerprint },
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
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => buildResults.shift(),
      pingDaemonImpl: async () => ({
        ok: true,
        pid: pingPid,
        distClosureFingerprint: manifest.fingerprint,
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
  writeDistBuildManifestForTest(distIndexPath);

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
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-superseded-build-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  const { manifest } = writeDistBuildManifestForTest(distIndexPath);

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
        coldStartArgs = args;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), {
    ok: true,
    allowSupersededActivation: true,
  });
  assert.deepEqual(await executor.restart(), {
    restarted: true,
    mode: 'cold-start',
    degraded: true,
  });
  assert.equal(coldStartArgs.admittedDistClosureFingerprint, manifest.fingerprint);
});

test('reload executor activates a successful superseded publication over a healthy incumbent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-superseded-incumbent-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  writeDistBuildManifestForTest(distIndexPath);

  let replacementCalls = 0;
  let coldStartCalls = 0;
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
        return { status: 'restarting', pid: 222 };
      },
      startLocalDaemonWithAuthImpl: async () => {
        coldStartCalls += 1;
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
  assert.equal(coldStartCalls, 0);
});

test('reload executor uses daemon control restart and synchronizes runtime state', async () => {
  let restartArgs = null;
  let syncArgs = null;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: '/tmp/stack.runtime.json',
      isShuttingDown: () => false,
      env: { TEST_ENV: '1' },
      stackName: 'dev',
    },
    {
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async (args) => {
        restartArgs = args;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async (args) => { syncArgs = args; },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });
  assert.equal(restartArgs.stackName, 'dev');
  assert.equal(restartArgs.env.TEST_ENV, '1');
  assert.equal(syncArgs.runtimeStatePath, '/tmp/stack.runtime.json');
});

test('successful CLI publication waits for a live startup daemon to publish its control state before activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-control-state-race-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  writeDistBuildManifestForTest(distIndexPath);

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

test('reload executor carries the admitted dist fingerprint through overlap confirmation and runtime projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-fingerprint-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  const { manifest } = writeDistBuildManifestForTest(distIndexPath);

  let restartArgs = null;
  let syncArgs = null;
  let successorObservation = null;
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
      env: { TEST_ENV: '1' },
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async (args) => {
        restartArgs = args;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async (args, options) => {
        syncArgs = args;
        successorObservation = await options.checkDaemonStateImpl();
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), { ok: true, allowSupersededActivation: true });
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });
  assert.equal(restartArgs.successorDistClosureFingerprint, manifest.fingerprint);
  assert.equal(syncArgs.runtimeDaemonPid, 222);
  assert.equal(syncArgs.daemonDistFingerprint, manifest.fingerprint);
  assert.deepEqual(successorObservation, {
    status: 'running',
    pid: 222,
    distClosureFingerprint: manifest.fingerprint,
  });
});

test('reload executor retries before daemon mutation when the admitted workspace runtime publication was superseded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-workspace-runtime-race-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  writeDistBuildManifestForTest(distIndexPath, {
    workspaceRuntimeIdentity: 'a'.repeat(64),
    workspaceRuntimePackages: ['@happier-dev/protocol'],
  });

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
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
      readCliWorkspaceRuntimeIdentityImpl: () => ({
        fingerprint: 'b'.repeat(64),
        packageCount: 1,
        packageNames: ['@happier-dev/protocol'],
      }),
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
        return { status: 'restarting', previousPid: 111, pid: 222 };
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await executor.build();
  await assert.rejects(
    () => executor.restart(),
    (error) => (
      error?.code === 'ECLIWORKSPACERUNTIMEADVANCED'
      && error?.reloadRetryAfterMs === 250
      && /changed before daemon activation/.test(error.message)
    ),
  );
  assert.equal(restartCalls, 0);
});

test('reload executor does not project runtime state when fingerprint confirmation fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-fingerprint-failure-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  writeDistBuildManifestForTest(distIndexPath);

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
      runtimeStatePath: join(root, 'stack.runtime.json'),
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

test('reload executor carries the admitted dist fingerprint into a cold daemon start', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-reload-cold-fingerprint-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await writeFile(distIndexPath, 'export const daemon = true;\n', 'utf-8');
  const { manifest } = writeDistBuildManifestForTest(distIndexPath);

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
      stackName: 'dev',
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, current: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: false, reason: 'daemon_not_running' }),
      startLocalDaemonWithAuthImpl: async (args) => {
        coldStartArgs = args;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.build(), { ok: true, allowSupersededActivation: true });
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'cold-start' });
  assert.equal(coldStartArgs.admittedDistClosureFingerprint, manifest.fingerprint);
});

test('reload executor cold-starts only after explicit daemon absence', async () => {
  let coldStartArgs = null;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      pingDaemonImpl: async () => ({ ok: false, reason: 'daemon_not_running' }),
      startLocalDaemonWithAuthImpl: async (args) => { coldStartArgs = args; },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'cold-start' });
  assert.equal(coldStartArgs.forceRestart, false);
  assert.equal(coldStartArgs.preserveExistingRunning, true);
});

test('reload executor awaits a stale source generation after control ping before restart activation', async () => {
  let restartCalls = 0;
  let revalidationCalls = 0;
  let releaseRevalidation;
  const revalidationBlocked = new Promise((resolve) => {
    releaseRevalidation = resolve;
  });
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        restartCalls += 1;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  const restart = executor.restart({
    revalidateGeneration: async () => {
      revalidationCalls += 1;
      await revalidationBlocked;
      return false;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revalidationCalls, 1, 'the daemon executor must consume the coordinator generation fence');
  assert.equal(restartCalls, 0, 'control restart must wait for generation revalidation');
  releaseRevalidation();

  assert.deepEqual(await restart, { skipped: true, reason: 'stale-generation' });
  assert.equal(restartCalls, 0, 'a stale generation must not reach the irreversible control restart');
});

test('reload executor awaits a stale source generation before cold-start activation', async () => {
  let coldStarts = 0;
  let revalidationCalls = 0;
  let releaseRevalidation;
  const revalidationBlocked = new Promise((resolve) => {
    releaseRevalidation = resolve;
  });
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
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
      revalidationCalls += 1;
      await revalidationBlocked;
      return false;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revalidationCalls, 1, 'the daemon executor must consume the coordinator generation fence');
  assert.equal(coldStarts, 0, 'cold start must wait for generation revalidation');
  releaseRevalidation();

  assert.deepEqual(await restart, { skipped: true, reason: 'stale-generation' });
  assert.equal(coldStarts, 0, 'a stale generation must not reach cold-start activation');
});

test('reload executor preserves a live recorded daemon when control state is missing', async () => {
  let coldStarts = 0;
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: '/tmp/stack.runtime.json',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      pingDaemonImpl: async () => ({ ok: false, reason: 'missing_state' }),
      readStackRuntimeStateFileImpl: async () => ({ processes: { daemonPid: 111 } }),
      isPidAliveImpl: (pid) => pid === 111,
      startLocalDaemonWithAuthImpl: async () => { coldStarts += 1; },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.deepEqual(await executor.restart(), {
    skipped: true,
    reason: 'daemon-control-unavailable:missing_state',
  });
  assert.equal(coldStarts, 0);
});
