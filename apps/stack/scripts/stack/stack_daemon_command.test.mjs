// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installStubDaemonSourceBuildInputs } from '../testkit/core/source_runtime_fixture.mjs';
import { prepareStubHappierCliDependencies } from '../testkit/core/stub_happier_cli_files.mjs';
import { resolveStackDaemonCommandContext } from './stack_daemon_command.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';
import { stopLocalDaemon } from '../daemon.mjs';
import { recordStackRuntimeStart } from '../utils/stack/runtime_state.mjs';
import { resolveStackBaseDir } from '../utils/paths/paths.mjs';

for (const evidence of ['absent', 'previous-boot', 'live']) {
  test(`stale source daemon cleanup preserves process authority (${evidence})`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-stale-source-retirement-' });
    const bundleDir = fixture.path('retained-source');
    const cliDir = join(bundleDir, 'apps', 'cli');
    await mkdir(join(cliDir, 'src'), { recursive: true });
    const entrypoint = join(cliDir, 'src', 'index.mjs');
    await writeFile(entrypoint, 'throw new Error("retired source must not be launched");\n');
    await writeFile(join(bundleDir, 'source-bundle.json'), JSON.stringify({ dependencyPublication: null }));
    const stackName = 'stale-source-retirement';
    const runtimeStatePath = fixture.path('stack.runtime.json');
    const pid = evidence === 'absent' ? 2147483647 : process.pid;
    const state = await recordStackRuntimeStart(runtimeStatePath, {
      stackName, ownerPid: pid, processes: { daemonPid: pid },
      sourceRuntimeLaunch: { entrypoint, cliDir, env: {} },
    });
    if (evidence === 'previous-boot') {
      await writeFile(runtimeStatePath, JSON.stringify({ ...state, startedAt: '2000-01-01T00:00:00.000Z' }));
    }
    // Keep the genuine identity checks; intercept only an OS signal to this test process.
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (target, signal) => {
      if (target === process.pid) assert.equal(signal, 0, 'cleanup must not signal the live replacement');
      return kill(target, signal);
    });
    const stop = () => stopLocalDaemon({ cliBin: fixture.path('missing-cli'),
      cliHomeDir: fixture.path('cli'), internalServerUrl: '', runtimeStatePath, stackName,
      env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
        HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    if (evidence === 'live') await assert.rejects(stop, { code: 'daemon_stop_incomplete' });
    else await stop();
    assert.doesNotThrow(() => kill(process.pid, 0));
  });
}

test('daemon stop reaches retained cleanup while stale source status stays refused', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-stale-source-stop-' });
  const bundleDir = fixture.path('retained-source');
  const cliDir = join(bundleDir, 'apps', 'cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  const entrypoint = join(cliDir, 'src', 'index.mjs');
  await writeFile(entrypoint, 'throw new Error("retired source must not be launched");\n');
  await writeFile(join(bundleDir, 'source-bundle.json'), JSON.stringify({ dependencyPublication: null }));
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const runtimePath = fixture.path('stack.runtime.json');
  const input = { rootDir: join(repoDir, 'apps/stack'), stackName: 'stale-source-stop', identity: 'default',
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
      HAPPIER_STACK_CLI_HOME_DIR: fixture.path('cli'), HAPPIER_STACK_RUNTIME_STATE_PATH: runtimePath },
    activeRuntimeState: { sourceRuntimeLaunch: { entrypoint, cliDir, env: {} },
      sourceRuntimeIdentities: { daemon: { selected: 'prior-boot', loaded: 'prior-boot' } } } };
  const stop = await resolveStackDaemonCommandContext({ ...input, argv: ['stop'] });
  assert.equal(stop.cliHomeDir, fixture.path('cli'));
  assert.equal(stop.runtimePath, runtimePath);
  await assert.rejects(() => resolveStackDaemonCommandContext({ ...input, argv: ['status'] }),
    { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' });
});

// P03-INFRA-ASKS (FLEET DISPATCH 11-18): repo-dev is a live (`stack dev`) Stack. Its
// selected daemon capture links the moving dependency installation, so each
// dependency publication makes it refuse (`closure_changed`). A named daemon start
// must prepare current source like the default daemon, not join that selection.
test('a named daemon on a live Stack prepares current source instead of joining a stale selection', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-live-named-daemon-' });
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const stackName = 'live-named-daemon';
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_STACK_CLI_HOME_DIR: fixture.path('cli'), HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_RUNTIME_MODE: 'live' };
  const stackBaseDir = resolveStackBaseDir(stackName, env).baseDir;
  const bundleDir = join(dirname(stackBaseDir), 'source-bundles', 'runtime-live-selected');
  const cliDir = join(bundleDir, 'apps', 'cli');
  const entrypoint = join(cliDir, 'src', 'index.mjs');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(entrypoint, 'throw new Error("stale selection must not be launched");\n');
  // A linked (uncaptured) capture whose recorded installation no longer matches.
  const markerPath = fixture.path('install/node_modules/.happier-stack-dependencies-ready');
  const generationPath = fixture.path('install/dependency-install.lock.generation');
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify({ identity: 'current-install' }));
  await writeFile(generationPath, JSON.stringify({ generation: 'g2', completedGeneration: 'g2' }));
  await writeFile(join(bundleDir, 'source-bundle.json'), JSON.stringify({ identity: 'live-selected', entrypoint, cliDir, env: {},
    dependencyPublication: { identity: 'previous-install', generation: 'g1', completedGeneration: 'g1', writerActive: false, markerPath, generationPath },
    runtimeDependencyClosure: { identity: 'previous-closure', imports: [] } }));
  await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
  await writeFile(join(stackBaseDir, 'source-runtime', 'selected-daemon.json'), JSON.stringify({ entrypoint }));
  // The fixture checkout has no sources, so current-source preparation fails at the
  // producer: the point is that the start reaches preparation instead of refusing.
  const emptyRoot = fixture.path('empty-checkout/apps/stack');
  await mkdir(emptyRoot, { recursive: true });
  const error = await resolveStackDaemonCommandContext({ rootDir: emptyRoot, stackName, identity: 'qa-named', env,
    argv: ['start', '--runtime=source'], activeRuntimeState: null }).then(() => null, caught => caught);
  assert.notEqual(error?.code, 'SOURCE_RUNTIME_RELOAD_REQUIRED', 'a live named start must not join the stale selection');
});

// P03-TOOLING-ISOLATION (Usage 18:35Z): a daemon-only restart of a revision-tree
// Stack swapped in the producer's older bundle, so its daemon kept an old Iroh addon.
test('a revision-tree daemon restart relaunches the Stack\'s selected tree instead of selecting a capture', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-tree-daemon-restart-' });
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const stackName = 'tree-daemon-restart';
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_STACK_CLI_HOME_DIR: fixture.path('cli'), HAPPIER_STACK_STACK: stackName };
  const stackBaseDir = resolveStackBaseDir(stackName, env).baseDir;
  const treeDir = join(stackBaseDir, 'source-runtime', 'tree-daemon-fixture');
  const cliDir = join(treeDir, 'apps', 'cli');
  const entrypoint = join(cliDir, 'src', 'index.mjs');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(entrypoint, 'export {};\n');
  await writeFile(join(treeDir, 'source-bundle.json'), JSON.stringify({ identity: 'tree-identity', entrypoint, cliDir, env: {},
    dependencyPublication: null, runtimeDependencyClosure: { captured: true, identity: 'fixture-install', imports: [] },
    sourceTree: { base: 'a'.repeat(40), baseBuilt: false, overlaid: 0 } }));
  await writeFile(join(stackBaseDir, 'source-runtime', 'selected-daemon.json'), JSON.stringify({ entrypoint }));
  const restart = await resolveStackDaemonCommandContext({ rootDir: join(repoDir, 'apps/stack'), stackName, identity: 'default', env,
    argv: ['restart', '--runtime=source'],
    activeRuntimeState: { sourceRuntimeLaunch: { entrypoint, cliDir, env: {} },
      sourceRuntimeIdentities: { daemon: { selected: 'tree-identity', loaded: 'tree-identity' } } } });
  assert.equal(restart.cliEntrypoint, entrypoint);
  assert.equal(restart.sourceRuntimeLaunchUpdate?.launch.entrypoint, entrypoint);
  assert.equal(restart.sourceRuntimeLaunchUpdate?.identity, 'tree-identity');
});

for (const action of ['start', 'restart']) {
test(`explicit source daemon ${action} prepares current source while status retains the incumbent launch`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-daemon-refresh-', registerCleanup: false });
  t.after(async () => {
    const makeWritable = async directory => {
      await chmod(directory, 0o755);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
      }
    };
    await makeWritable(fixture.root);
    await fixture.cleanup();
  });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const directory of ['apps/cli/src', 'apps/ui/scripts', 'apps/stack/scripts/build', 'scripts/workspaces']) {
    await mkdir(join(repoDir, directory), { recursive: true });
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(repoDir, 'apps/cli/tsconfig.json'), '{}');
  const transportSource = join(repoDir, 'apps/cli/src/daemon/peer/iroh/daemonHomeIrohTransport.ts');
  await mkdir(join(transportSource, '..'), { recursive: true });
  await writeFile(transportSource, 'export const transportRevision = "first-route";');
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'),
    'export { transportRevision } from "./daemon/peer/iroh/daemonHomeIrohTransport"; export const sourceReload = "current-source";');
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  for (const name of ['prepareSourcePluginUiArtifacts.mjs', 'generateBundledPluginUiArtifacts.mjs']) {
    await writeFile(join(repoDir, 'apps/ui/scripts', name), '');
  }
  await mkdir(join(repoDir, 'packages'));
  await symlink(join(canonicalRepo, 'packages/plugin-sdk'), join(repoDir, 'packages/plugin-sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await installStubDaemonSourceBuildInputs(repoDir);
  const dependencyEnv = await prepareStubHappierCliDependencies(repoDir, {
    env: sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
  });
  const require = createRequire(import.meta.url);
  for (const dependency of ['tsx', 'semver']) {
    await symlink(join(require.resolve(`${dependency}/package.json`), '..'),
      join(repoDir, 'node_modules', dependency), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const oldEntrypoint = fixture.path('retained/apps/cli/src/incumbent.mjs');
  await mkdir(join(oldEntrypoint, '..'), { recursive: true });
  await writeFile(oldEntrypoint, 'export const sourceReload = "incumbent";');
  const input = { rootDir: join(canonicalRepo, 'apps/stack'), stackName: 'fixture', identity: action === 'start' ? 'qa-f-e2ee-fixtures' : 'default',
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
      ...dependencyEnv, HAPPIER_STACK_CLI_HOME_DIR: fixture.path('cli') },
    activeRuntimeState: { sourceRuntimeLaunch: { entrypoint: oldEntrypoint, cliDir: join(repoDir, 'apps/cli') },
      sourceRuntimeIdentities: { daemon: { selected: 'incumbent', loaded: 'incumbent' } } } };
  const status = await resolveStackDaemonCommandContext({ ...input, argv: ['status', '--runtime=source'] });
  assert.equal(status.cliEntrypoint, oldEntrypoint);
  // A retained graph without a usable dependency publication cannot launch,
  // but an explicit reload must prepare its replacement before validating it.
  if (action === 'restart') await writeFile(fixture.path('retained/source-bundle.json'), JSON.stringify({ dependencyPublication: null }));
  const restart = await resolveStackDaemonCommandContext({ ...input, argv: [action, '--runtime=source'] });
  assert.notEqual(restart.cliEntrypoint, oldEntrypoint);
  const emitted = await import(pathToFileURL(restart.cliEntrypoint).href);
  assert.equal(emitted.sourceReload, 'current-source');
  assert.equal(emitted.transportRevision, 'first-route');
  await writeFile(transportSource, 'export const transportRevision = "current-route";');
  const refreshed = await resolveStackDaemonCommandContext({ ...input, argv: [action, '--runtime=source'],
    activeRuntimeState: { ...input.activeRuntimeState,
      sourceRuntimeLaunch: restart.sourceRuntimeLaunchUpdate?.launch ?? input.activeRuntimeState.sourceRuntimeLaunch } });
  assert.notEqual(refreshed.cliEntrypoint, restart.cliEntrypoint);
  assert.equal((await import(pathToFileURL(refreshed.cliEntrypoint).href)).transportRevision, 'current-route');
  const recovered = await resolveStackDaemonCommandContext({ ...input, argv: ['restart'],
    activeRuntimeState: { ...input.activeRuntimeState,
      sourceRuntimeLaunch: { ...input.activeRuntimeState.sourceRuntimeLaunch, entrypoint: fixture.path('missing.mjs') } } });
  assert.equal(recovered.cliEntrypoint, refreshed.cliEntrypoint);
  assert.equal(await readFile(oldEntrypoint, 'utf8'), 'export const sourceReload = "incumbent";');
});
}
