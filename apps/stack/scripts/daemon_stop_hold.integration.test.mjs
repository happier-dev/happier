import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv, buildStackFixtureEnv } from './testkit/core/env_scope.mjs';
import { checkDaemonStatePingAware, getDaemonEnv, startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { runStackDaemonCommand } from './stack/stack_daemon_command.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { recordStackRuntimeUpdate, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { startOwnerDaemonLifecycleReconciler } from './utils/dev/daemonLifecycleReconciler.mjs';
import { syncStackRuntimeDaemonPidFromDaemonState } from './utils/stack/runtime_daemon_state.mjs';
import { spawnDaemonLikeProcess } from './testkit/core/spawn_daemon_like_process.mjs';

test('explicit daemon stop survives normal reconciliation; crash recovery and explicit start preserve the server', { timeout: 60_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-daemon-stop-hold-', registerCleanup: false });
  const stackName = 'owner-stop';
  const baseDir = fixture.path(stackName);
  const cliHomeDir = join(baseDir, 'cli');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const envPath = join(baseDir, 'env');
  const statePath = join(cliHomeDir, 'servers', `stack_${stackName}__id_default`, 'daemon.state.json');
  const birthsPath = fixture.path('births');
  const cliEntrypoint = fixture.path('cli.mjs');
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const helperPath = fileURLToPath(new URL('./testkit/core/spawn_daemon_like_process.mjs', import.meta.url));
  const children = [];
  let reconciler;
  const server = http.createServer((_req, res) => res.end('serving'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const env = await getDaemonEnv({ cliHomeDir, internalServerUrl: serverUrl, publicServerUrl: serverUrl,
    stackName, cliIdentity: 'default', baseEnv: buildStackFixtureEnv({ stripStackEnv: true, storageDir: fixture.root, stackName, envPath,
    extraEnv: { HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_DEV_TARGET_EXECUTION: '1',
      HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath, HAPPIER_STACK_REPO_DIR: fixture.root,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0', HAPPIER_STACK_UPDATE_CHECK: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '15000', HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_SERVER_URL: serverUrl, HAPPIER_HOME_DIR: cliHomeDir } }) });
  withPatchedProcessEnv(t, env);
  t.after(async () => {
    reconciler?.close();
    await stopLocalDaemon({ cliBin: cliEntrypoint, cliEntrypoint, cliHomeDir,
      internalServerUrl: serverUrl, runtimeStatePath, stackName, env }).catch(() => {});
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fixture.cleanup();
  });
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'fixture-access\n');
  await writeFile(envPath, [
    'HAPPIER_STACK_RUNTIME_MODE=source', 'HAPPIER_STACK_SERVE_UI=0',
    `HAPPIER_STACK_REPO_DIR=${fixture.root}`, `HAPPIER_SERVER_URL=${serverUrl}`,
    'HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS=0', '',
  ].join('\n'));
  // Only the executable CLI/daemon boundary is a fixture; command admission,
  // persisted desired state, reconciliation, transport and membership stay real.
  await writeFile(cliEntrypoint, `
import { appendFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(helperPath)};
if (process.argv[2] === 'daemon' && process.argv[3] === 'start') {
  appendFileSync(${JSON.stringify(birthsPath)}, 'start\\n');
  spawnDaemonLikeProcess({ cliHomeDir: process.env.HAPPIER_HOME_DIR,
    internalServerUrl: process.env.HAPPIER_SERVER_URL,
    statePaths: [${JSON.stringify(statePath)}] });
}
`);
  await recordStackRuntimeUpdate(runtimeStatePath, { stackName, processes: {},
    sourceRuntimeLaunch: { entrypoint: cliEntrypoint, cliDir: fixture.root },
    sourceRuntimeIdentities: { daemon: { selected: 'fixture', loaded: 'fixture' } } });
  const options = { cliBin: cliEntrypoint, cliEntrypoint, cliHomeDir, internalServerUrl: serverUrl,
    runtimeStatePath, stackName, env, isShuttingDown: () => false };
  const births = async () => (await readFile(birthsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  const serving = async () => {
    const response = await fetch(serverUrl);
    assert.equal(await response.text(), 'serving');
  };
  const serverFailures = [];
  let sampling = true;
  const serverChecks = (async () => {
    while (sampling) {
      try { await serving(); } catch (error) { serverFailures.push(error); }
      await delay(50);
    }
  })();
  t.after(async () => { sampling = false; await serverChecks; });
  const observe = () => checkDaemonStatePingAware(cliHomeDir, { serverUrl, stackName, env });
  const installReconciler = () => startOwnerDaemonLifecycleReconciler({ enabled: true, runtimeStatePath,
    observe, onObservation: daemonState => syncStackRuntimeDaemonPidFromDaemonState({
      runtimeStatePath, cliHomeDir, internalServerUrl: serverUrl, env, daemonState }),
    recover: () => startLocalDaemonWithAuth(options),
  });
  // A real process starts with the same stack identity as the command.
  const initial = spawnDaemonLikeProcess({ cliHomeDir, statePaths: [statePath], internalServerUrl: serverUrl, env });
  children.push(initial);
  for (let i = 0; i < 200 && (await observe()).status !== 'running'; i++) await delay(25);
  assert.equal((await observe()).status, 'running');
  reconciler = installReconciler();
  await reconciler.reconcileNow();
  await runStackDaemonCommand({ rootDir, stackName, argv: ['stop'], json: true });
  assert.ok(['stopped', 'stale_state', 'stale_lock'].includes((await observe()).status));
  // Exercise the normal one-second timer for more than its two-absence threshold.
  const startsBeforeHold = await births();
  await delay(3_200);
  await reconciler.reconcileNow();
  assert.equal(await births(), startsBeforeHold, 'explicit stop must cause zero respawns');
  assert.equal((await startLocalDaemonWithAuth(options)).reason, 'daemon-stopped-by-owner',
    'automatic launch paths must honor the same desire as the reconciler');
  assert.equal(await births(), startsBeforeHold);
  await serving();
  reconciler.close();
  reconciler = installReconciler();
  await reconciler.reconcileNow();
  await reconciler.reconcileNow();
  assert.equal(await births(), startsBeforeHold, 'owner reinstallation must retain stopped desire');
  const info = await readStackInfoSnapshot({ rootDir, stackName });
  assert.equal(info.runtime.components.daemon.desiredState, 'stopped');
  assert.equal(info.runtime.components.daemon.status, 'stopped-by-owner');
  assert.equal(info.runtime.health.issues.includes('daemon_down'), false);
  await runStackDaemonCommand({ rootDir, stackName, argv: ['start'], json: true });
  assert.equal((await observe()).status, 'running', 'explicit start must clear the persisted stop');
  assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).daemon.desiredStateByIdentity.default, 'running');
  await reconciler.reconcileNow();
  const beforeCrash = await births();
  // The replacement is this fixture's child, identified by its own state path.
  const { pid } = JSON.parse(await readFile(statePath, 'utf8'));
  process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 200 && (await observe()).status === 'running'; i++) await delay(25);
  for (let i = 0; i < 4; i++) await reconciler.reconcileNow();
  assert.equal(await births(), beforeCrash + 1, 'one crash must produce exactly one restart');
  assert.equal((await observe()).status, 'running');
  await serving();
  assert.deepEqual(serverFailures, [], 'server must keep serving during stop, hold, start and crash recovery');
});
