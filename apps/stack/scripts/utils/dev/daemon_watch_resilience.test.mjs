import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHappyCliReloadDescriptors,
  createHappyCliReloadExecutor,
  createHappyCliWorkspacePreparationExecutor,
  prepareDevDaemonSourceRuntime,
  startDevDaemon,
} from './daemon.mjs';
import { createDevServerReloadDescriptors } from './server.mjs';
import { resolveCliRuntimeLaunchSpec } from '../../runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { readHappyCliRuntimeInputFreshness } from '../proc/cli_runtime_inputs.mjs';

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
  await writeFile(join(root, 'pnpm-lock.yaml'), '# workspace build input\n', 'utf-8');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf-8');
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
  assert.ok(paths.includes(join(root, 'pnpm-lock.yaml')));
  assert.ok(paths.includes(join(root, 'pnpm-workspace.yaml')));
  assert.equal(descriptors.find((descriptor) => descriptor.id === 'shared:plugin-sdk')?.target, 'daemon');
  const serverDir = join(root, 'apps', 'server');
  await mkdir(serverDir, { recursive: true });
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@fixture/server', dependencies: {
    '@happier-dev/agents': '0.0.0', '@happier-dev/plugins-codex': '0.0.0',
  } }));
  const serverDescriptors = await createDevServerReloadDescriptors({ serverDir });
  assert.equal(descriptors.find((descriptor) => descriptor.id === 'shared:agents')?.target, 'daemon');
  assert.equal(serverDescriptors.find((descriptor) => descriptor.id === 'shared:agents')?.target, 'shared');
  assert.equal(serverDescriptors.find((descriptor) => descriptor.id === 'shared:plugins-codex')?.target, 'shared',
    'nested workspace identity must match the daemon descriptor for the same package');
  assert.equal(serverDescriptors.some((descriptor) => descriptor.id === 'shared:plugin-sdk'), false);
  assert.equal(
    descriptors.some((descriptor) => descriptor.id === 'daemon:cli-publication'),
    false,
    'the dev daemon runs captured source, so a CLI dist publication is not a reload input',
  );
  assert.ok(!paths.some((path) => path.includes('/dist')));

  const emailDir = join(root, 'packages', 'email-transports-protocol');
  await mkdir(join(emailDir, 'src'), { recursive: true });
  await writeFile(join(emailDir, 'package.json'), JSON.stringify({ name: '@happier-dev/email-transports-protocol' }));
  await writeFile(join(root, 'packages', 'protocol', 'package.json'), JSON.stringify({
    name: '@happier-dev/protocol', dependencies: { '@happier-dev/email-transports-protocol': '0.0.0' },
  }));
  const movingDescriptors = createHappyCliReloadDescriptors({ cliDir });
  assert.ok(movingDescriptors.flatMap(descriptor => descriptor.paths).includes(join(emailDir, 'src')),
    'observation must include undeclared bundled inputs without vetoing last-green startup');
  await assert.rejects(() => readHappyCliRuntimeInputFreshness(cliDir), /Missing bundled internal workspace dependencies.*[\s\S]*email-transports-protocol/,
    'the background build still reports the actionable validation failure');
  await writeFile(join(root, 'packages', 'protocol', 'package.json'), '{');
  assert.ok(createHappyCliReloadDescriptors({ cliDir }).flatMap(descriptor => descriptor.paths).includes(join(root, 'packages')),
    'a partially edited manifest cannot kill a runner serving last-green output; package corrections remain observed');
  await writeFile(join(serverDir, 'package.json'), '{');
  assert.ok((await createDevServerReloadDescriptors({ serverDir })).flatMap(descriptor => descriptor.paths).includes(join(root, 'packages')));
  await assert.rejects(() => readHappyCliRuntimeInputFreshness(cliDir), SyntaxError);
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

test('workspace preparation executor coalesces concurrent publications and permits a later refresh', async () => {
  let releaseFirstBuild;
  const firstBuild = new Promise((resolve) => {
    releaseFirstBuild = resolve;
  });
  let calls = 0;
  const executor = createHappyCliWorkspacePreparationExecutor(
    {
      repoRoot: '/repo',
      cliDir: '/repo/apps/cli',
    },
    {
      syncSharedDepsForSourceDevImpl: async () => {
        calls += 1;
        if (calls === 1) return await firstBuild;
        return { synced: true, reason: 'refreshed' };
      },
    },
  );

  const optimisticPreparation = executor.build();
  const supervisorPreparation = executor.build();
  await Promise.resolve();
  assert.equal(calls, 1);

  releaseFirstBuild({ synced: true, reason: 'completed' });
  assert.deepEqual(await Promise.all([optimisticPreparation, supervisorPreparation]), [
    { synced: true, reason: 'completed' },
    { synced: true, reason: 'completed' },
  ]);
  assert.deepEqual(await executor.build(), { synced: true, reason: 'refreshed' });
  assert.equal(calls, 2);
});

const quietLogger = { log() {}, warn() {}, error() {} };
const sourceGeneration = (identity) => ({
  launch: { entrypoint: `/bundles/${identity}/index.mjs`, cliDir: `/bundles/${identity}/cli`, env: {} },
  identity,
});

test('dev daemon source generation is the Stack source-runtime daemon bundle, retained at startup and current on reload', async () => {
  const requests = [];
  const buildSourceRuntimeBundleImpl = async (options) => {
    requests.push(options);
    return { entrypoint: '/b/index.mjs', cliDir: '/b/cli', env: { A: '1' }, identity: 'gen-1', lastGreen: options.reuseSelected === true };
  };
  const sourceRuntimeOptions = { repoDir: '/repo', stackBaseDir: '/stacks/dev' };

  const retained = await prepareDevDaemonSourceRuntime(
    { sourceRuntimeOptions, env: {}, reuseSelected: true },
    { buildSourceRuntimeBundleImpl, logger: quietLogger },
  );
  const current = await prepareDevDaemonSourceRuntime(
    { sourceRuntimeOptions, env: {} },
    { buildSourceRuntimeBundleImpl, logger: quietLogger },
  );

  assert.deepEqual(retained, { launch: { entrypoint: '/b/index.mjs', cliDir: '/b/cli', env: { A: '1' } }, identity: 'gen-1' });
  assert.deepEqual(current, retained);
  // The real launch owner (the consumer of startLocalDaemonWithAuth's sourceRuntimeLaunchUpdate) accepts the produced launch.
  const consumed = resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: current.launch });
  assert.equal(consumed.entrypoint, '/b/index.mjs');
  assert.equal(consumed.cliDir, '/b/cli');
  assert.deepEqual(requests.map((r) => [r.component, r.repoDir, r.stackBaseDir, r.reuseSelected, r.waitForSourceChanges]), [
    ['daemon', '/repo', '/stacks/dev', true, false],
    ['daemon', '/repo', '/stacks/dev', false, false],
  ]);
});

test('the real source-runtime owner refuses to build when startup asks for a retained generation and none exists', async (t) => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'hs-daemon-no-retained-'));
  t.after(async () => rm(stackBaseDir, { recursive: true, force: true }));
  await assert.rejects(
    () => prepareDevDaemonSourceRuntime(
      { sourceRuntimeOptions: { repoDir: join(stackBaseDir, 'repo'), stackBaseDir }, env: {}, reuseSelected: true },
      { logger: quietLogger },
    ),
    /selected source daemon bundle is unavailable/,
  );
});

test('startDevDaemon retains source at startup and prepares current source for an explicit restart', async () => {
  let launch = null;
  const prepared = [];
  await startDevDaemon(
    {
      startDaemon: true,
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      restart: false,
      isShuttingDown: () => false,
      env: { TEST_ENV: '1' },
      stackName: 'dev',
      cliIdentity: 'reviewer',
      sourceRuntimeOptions: { repoDir: '/repo', stackBaseDir: '/stacks/dev' },
    },
    {
      prepareDevDaemonSourceRuntimeImpl: async (input) => { prepared.push(input.reuseSelected); return sourceGeneration('gen-1'); },
      startLocalDaemonWithAuthImpl: async (args) => { launch = args; },
    },
  );
  assert.deepEqual(prepared, [true]);
  assert.deepEqual(launch.sourceRuntimeLaunchUpdate, sourceGeneration('gen-1'));
  assert.equal(launch.admitPriorDistImmediately, undefined);
  assert.equal(launch.forceRestart, false);
  assert.equal(launch.stackName, 'dev');
  assert.equal(launch.cliIdentity, 'reviewer');
  assert.equal(launch.env.TEST_ENV, '1');

  await startDevDaemon(
    {
      startDaemon: true, cliHomeDir: '/tmp/happy-cli-home-restart', internalServerUrl: 'http://127.0.0.1:3009',
      startDaemon: true, restart: true, stackName: 'dev', sourceRuntimeOptions: {},
    },
    {
      prepareDevDaemonSourceRuntimeImpl: async (input) => { prepared.push(input.reuseSelected); return sourceGeneration('gen-2'); },
      startLocalDaemonWithAuthImpl: async (args) => { launch = args; },
    },
  );
  assert.equal(prepared[1], false, 'an explicit restart prepares current source before replacing the daemon');
  assert.equal(launch.forceRestart, true);
});

function singleFlightDependencies(startLocalDaemonWithAuthImpl) {
  return {
    prepareDevDaemonSourceRuntimeImpl: async () => sourceGeneration('gen-1'),
    startLocalDaemonWithAuthImpl,
  };
}

test('startDevDaemon joins concurrent starts for the same daemon scope and permits a later start', async () => {
  let releaseStart;
  const blockedStart = new Promise((resolve) => { releaseStart = resolve; });
  let starts = 0;
  const options = {
    startDaemon: true,
    cliHomeDir: '/tmp/happier-single-flight-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    stackName: 'single-flight-test',
  };
  const dependencies = singleFlightDependencies(async () => {
    starts += 1;
    if (starts === 1) await blockedStart;
  });

  const initial = startDevDaemon(options, dependencies);
  const recovery = startDevDaemon({ ...options, preserveExistingRunning: true }, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  releaseStart();
  assert.deepEqual(await Promise.all([initial, recovery]), [{ started: true }, { started: true }]);
  assert.deepEqual(await startDevDaemon(options, dependencies), { started: true });
  assert.equal(starts, 2);
});

test('startDevDaemon runs a requested restart after an in-flight ordinary start', async () => {
  let releaseStart;
  const blockedStart = new Promise((resolve) => { releaseStart = resolve; });
  const forceRestarts = [];
  const options = {
    startDaemon: true,
    cliHomeDir: '/tmp/happier-queued-restart-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    stackName: 'queued-restart-test',
  };
  const dependencies = singleFlightDependencies(async ({ forceRestart }) => {
    forceRestarts.push(forceRestart);
    if (forceRestarts.length === 1) await blockedStart;
  });
  const initial = startDevDaemon(options, dependencies);
  const restart = startDevDaemon({ ...options, restart: true }, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forceRestarts, [false]);
  releaseStart();
  await Promise.all([initial, restart]);
  assert.deepEqual(forceRestarts, [false, true]);
});

test('startDevDaemon keeps the stack running when source preparation or launch fails, leaving the retry to reload and recovery', async () => {
  for (const failing of ['prepare', 'launch']) {
    const warnings = [];
    const result = await startDevDaemon(
      { startDaemon: true, cliHomeDir: `/tmp/happy-cli-home-${failing}`, internalServerUrl: 'http://127.0.0.1:3009', stackName: 'dev' },
      {
        prepareDevDaemonSourceRuntimeImpl: async () => {
          if (failing === 'prepare') throw new Error('foreign syntax error in source');
          return sourceGeneration('gen-1');
        },
        startLocalDaemonWithAuthImpl: async () => { throw new Error('daemon credentials were rejected'); },
        logger: { warn(message) { warnings.push(message); } },
      },
    );
    assert.deepEqual(result, { started: false, reason: 'daemon-start-failed' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], failing === 'prepare' ? /foreign syntax error in source/ : /credentials were rejected/);
  }
});

test('startDevDaemon tells the user the first daemon build is underway, not to restart, when no source generation exists yet', async (t) => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'hs-daemon-first-build-'));
  t.after(async () => rm(stackBaseDir, { recursive: true, force: true }));
  const warnings = [];
  const result = await startDevDaemon(
    {
      startDaemon: true,
      cliHomeDir: join(stackBaseDir, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      stackName: 'dev',
      sourceRuntimeOptions: { repoDir: join(stackBaseDir, 'repo'), stackBaseDir },
      env: {},
    },
    {
      startLocalDaemonWithAuthImpl: async () => { throw new Error('must not launch without a source generation'); },
      logger: { log() {}, warn(message) { warnings.push(message); } },
    },
  );
  assert.deepEqual(result, { started: false, reason: 'daemon-awaiting-first-build' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /first daemon build/);
  assert.doesNotMatch(warnings[0], /restart the Stack/i);
});

function createExecutor({ ping, loaded = null, launches = [], prepared = [], runtimeStatePath = '/tmp/stack.runtime.json', ...overrides } = {}) {
  let generation = 0;
  return createHappyCliReloadExecutor(
    {
      startDaemon: true,
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath,
      isShuttingDown: () => false,
      stackName: 'dev',
      sourceRuntimeOptions: { repoDir: '/repo', stackBaseDir: '/stacks/dev' },
    },
    {
      prepareDevDaemonSourceRuntimeImpl: async (input) => {
        prepared.push(input);
        generation += 1;
        return sourceGeneration(`gen-${generation}`);
      },
      pingDaemonImpl: async () => ping,
      readStackRuntimeStateFileImpl: async () => ({ sourceRuntimeIdentities: { daemon: { loaded } } }),
      startLocalDaemonWithAuthImpl: async (args) => { launches.push(args); },
      logger: quietLogger,
      ...overrides,
    },
  );
}

test('reload executor builds current source with no CLI dist, build lease or typecheck involved', async () => {
  const prepared = [];
  const executor = createExecutor({ ping: { ok: true }, prepared });
  const built = await executor.build();
  assert.equal(built.ok, true);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].reuseSelected, undefined, 'a reload builds current source, never the retained generation');
});

test('reload executor replaces a healthy daemon with the prepared source generation, preserving sessions', async () => {
  const launches = [];
  const executor = createExecutor({ ping: { ok: true }, loaded: 'gen-0', launches });
  await executor.build();
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'overlap' });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].forceRestart, true);
  assert.equal(launches[0].preserveSessionsOnRestart, true);
  assert.deepEqual(launches[0].sourceRuntimeLaunchUpdate, sourceGeneration('gen-1'));
});

test('reload executor skips a healthy daemon that already loaded the prepared generation', async () => {
  const launches = [];
  const executor = createExecutor({ ping: { ok: true }, loaded: 'gen-1', launches });
  assert.deepEqual(await executor.build(), { ok: true });
  assert.deepEqual(await executor.restart(), { skipped: true, reason: 'daemon-source-already-active' });
  assert.equal(launches.length, 0);
});

test('reload executor keeps the incumbent when daemon control /restart is unavailable', async () => {
  const executor = createExecutor({
    ping: { ok: true }, loaded: 'gen-0',
    startLocalDaemonWithAuthImpl: async () => {
      throw Object.assign(new Error('daemon control /restart failed (404)'), { status: 404 });
    },
  });
  await executor.build();
  assert.deepEqual(await executor.restart(), { skipped: true, reason: 'daemon-control-restart-unavailable' });
});

test('reload executor propagates a replacement that could not load the selected generation', async () => {
  const executor = createExecutor({
    ping: { ok: true }, loaded: 'gen-0',
    startLocalDaemonWithAuthImpl: async () => { throw new Error('selected source daemon is not loaded after /restart'); },
  });
  await executor.build();
  await assert.rejects(() => executor.restart(), /not loaded after \/restart/);
});

test('reload executor cold-starts only after explicit daemon absence, and allows a superseded generation while none is loaded', async () => {
  const launches = [];
  const executor = createExecutor({ ping: { ok: false, reason: 'daemon_not_running' }, launches });
  assert.deepEqual(await executor.build(), { ok: true, allowSupersededActivation: true });
  assert.deepEqual(await executor.restart(), { restarted: true, mode: 'cold-start' });
  assert.equal(launches[0].forceRestart, false);
  assert.equal(launches[0].preserveExistingRunning, true);
  assert.deepEqual(launches[0].sourceRuntimeLaunchUpdate, sourceGeneration('gen-1'));
});

test('reload executor preserves a live recorded daemon when control state is missing', async () => {
  const launches = [];
  const executor = createExecutor({
    ping: { ok: false, reason: 'missing_state' }, launches,
    readStackRuntimeStateFileImpl: async () => ({ processes: { daemonPid: 4242 } }),
    isPidAliveImpl: (pid) => pid === 4242,
  });
  await executor.build();
  assert.deepEqual(await executor.restart(), { skipped: true, reason: 'daemon-control-unavailable:missing_state' });
  assert.equal(launches.length, 0);
});

test('reload executor propagates a build failure so the coordinator retries on the next source change', async () => {
  const executor = createExecutor({
    ping: { ok: true },
    prepareDevDaemonSourceRuntimeImpl: async () => { throw new Error('esbuild: syntax error'); },
  });
  await assert.rejects(() => executor.build(), /esbuild: syntax error/);
  assert.deepEqual(await executor.restart(), { skipped: true, reason: 'no-prepared-source' });
});
