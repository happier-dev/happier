import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildStackFixtureEnv, withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { spawnDetachedInlineNodeTestProcess } from './testkit/core/spawn_test_process.mjs';
import { readStackInfoSnapshot, resolveStackComponentRuntime } from './stack/stack_info_snapshot.mjs';
import { resolveQaBrowserUrl } from './utils/dev_targets/qa_browser.mjs';
import { resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
import { beginPendingSourceStart } from './runtime/shared/pending_source_start.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { captureStackRuntimeStopSnapshot, finalizeStackRuntimeStop, recordStackRuntimeStart, recordStackRuntimeStopRequest, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';

test('stack info preserves a remote daemon sign-in requirement', { timeout: 30_000 }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-sign-in-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: tmp });
  const stackName = 'sign-in-required';
  const base = join(tmp, stackName);
  await mkdir(base);
  await writeFile(join(base, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_SERVE_UI=0\n');
  await recordStackRuntimeStart(join(base, 'stack.runtime.json'), { stackName, ownerPid: null,
    sourceRuntimeIdentities: {}, placement: { daemon: 'worker' }, remoteTargets: { worker: {
      services: { daemon: true }, status: 'starting', phase: 'credentials',
      serviceStatus: { daemon: 'sign-in-required' },
    } } });
  const result = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(result.runtime.components.daemon.status, 'sign-in-required');
  assert.equal(result.runtime.components.daemon.running, false);
  assert.ok(result.runtime.health.issues.includes('daemon_sign_in_required'));
  const info = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./stack_commands.mjs', import.meta.url)), 'info', stackName], {
      signal: t.signal,
      env: buildStackFixtureEnv({ stripStackEnv: true, homeDir: join(tmp, 'home'), storageDir: tmp,
        extraEnv: { HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0', HAPPIER_STACK_UPDATE_CHECK: '0',
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' } }),
    });
  assert.ok(info.stdout.includes('daemon: sign-in required'), 'the CLI must present the typed authentication requirement');
});

for (const mode of ['owned', 'remote-owned', 'borrowed', 'remote-borrowed', 'dev-borrowed']) {
  const borrowed = mode.endsWith('borrowed');
  test(`stack info observes Expo status with stale records for ${mode} UI`, async t => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-expo-status-'));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: tmp });
    const producer = 'expo-producer';
    const stackName = borrowed ? 'expo-consumer' : producer;
    let serving = true;
    const requests = [];
    const metro = http.createServer((req, res) => {
      requests.push(req.url);
      // HTML alone must not make a failed status probe look ready.
      if (req.url !== '/status') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
        return;
      }
      res.writeHead(serving ? 200 : 503).end(serving ? 'packager-status:running' : 'unavailable');
    });
    await new Promise(resolve => metro.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { metro.closeAllConnections(); metro.close(resolve); }));
    const port = metro.address().port;
    for (const name of new Set([producer, stackName])) {
      await mkdir(join(tmp, name), { recursive: true });
      await writeFile(join(tmp, name, 'env'), [
        'HAPPIER_STACK_RUNTIME_MODE=source', 'HAPPIER_STACK_DAEMON=0',
        ...(name !== producer ? [`HAPPIER_STACK_EXPO_SOURCE_STACK=${producer}`] : []), '',
      ].join('\n'));
    }
    const statePath = join(tmp, producer, 'stack.runtime.json');
    const state = { stackName: producer, script: 'dev.mjs', sourceRuntimeIdentities: {},
      expo: { webPort: port, mobilePort: port, webEnabled: true }, processes: {},
      ...(mode.startsWith('remote-') ? { placement: { expo: 'worker' }, remoteTargets: {
        worker: { services: { expo: true }, status: 'retrying', serviceStatus: { expo: 'retrying' } },
      } } : {}),
    };
    if (borrowed) await writeFile(join(tmp, stackName, 'stack.runtime.json'), JSON.stringify({
      stackName, sourceRuntimeIdentities: {}, ...(mode === 'dev-borrowed' ? { script: 'dev.mjs' } : { sourceUi: 'borrowed' }), processes: {},
    }));
    // Missing, absent and unrelated live PIDs must not override HTTP readiness.
    for (const pid of [undefined, 2147483647, process.pid]) {
      state.processes = pid === undefined ? {} : { expoPid: pid };
      await writeFile(statePath, JSON.stringify(state));
      const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
      assert.equal(out.runtime.components.ui.running, true);
      assert.equal(out.runtime.health.issues.includes('ui_down'), false);
      assert.equal(out.ports.ui, port);
      assert.equal(out.runtime.components.ui.ownership, borrowed ? 'borrowed' : 'owned');
      assert.equal(out.runtime.components.ui.source, borrowed ? 'borrowed_expo' : mode === 'remote-owned' ? 'remote_target' : 'local');
      if (!borrowed) assert.equal(out.runtime.borrowedExpo, null);
    }
    assert.deepEqual(requests, ['/status', '/status', '/status'], 'one status request per snapshot; no page or bundle fetch');
    serving = false;
    requests.length = 0;
    const down = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(down.runtime.components.ui.running, false);
    assert.equal(down.runtime.health.issues.includes('ui_down'), true);
    assert.equal(down.ports.ui, null);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(path => path === '/status'), 'failed readiness must not fetch HTML or a bundle');
    if (borrowed) assert.equal(down.runtime.components.ui.status, 'waiting for dev Expo');
    serving = true;
    const recovered = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(recovered.runtime.components.ui.running, true);
    assert.equal(recovered.runtime.health.issues.includes('ui_down'), false);
  });
}

test('Info reports retained native retirement as incomplete after successful local finalization', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-pending-retirement-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const stackName = 'pending-retirement';
  const baseDir = join(tmp, stackName);
  await mkdir(baseDir);
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\n');
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: tmp });
  const statePath = join(baseDir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName, ownerPid: null,
    placement: { daemon: 'linux3' }, remoteTargets: { linux3: {
      services: { daemon: true }, runtimeMode: 'source-snapshot', status: 'retirement-pending', phase: 'stop',
      serviceStatus: { daemon: 'retirement-pending' },
    } } });
  const expected = await captureStackRuntimeStopSnapshot(statePath);
  const finalized = await finalizeStackRuntimeStop(statePath, { expected });
  assert.equal(finalized.finalized, true, 'local cleanup can succeed without remote confirmation');
  const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(out.runtime.running, false);
  assert.equal(out.runtime.stopRequest, null);
  assert.equal(out.runtime.health.status, 'degraded');
  assert.ok(out.runtime.health.issues.includes('stop_cleanup_incomplete'));
  assert.equal(out.runtime.remoteTargets.linux3.status, 'retirement-pending');
  await recordStackRuntimeUpdate(statePath, { remoteTargets: { linux3: {
    status: 'stopped', phase: null, serviceStatus: { daemon: 'stopped' },
  } } });
  const settled = await recordStackRuntimeStopRequest(statePath);
  assert.equal((await finalizeStackRuntimeStop(statePath, { expected: settled.expected })).finalized, true);
  const after = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(after.runtime.health.status, 'stopped');
  assert.equal(after.runtime.health.issues.includes('stop_cleanup_incomplete'), false);
});

test('stack info shares daemon transport observation within a snapshot and refreshes the next snapshot', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-observation-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const stackName = 'daemon-observation';
  const baseDir = join(tmp, stackName);
  await mkdir(baseDir);
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\n');
  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({ stackName, processes: {} }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: tmp });
  const cliHomeDir = join(baseDir, 'cli');
  const child = await spawnStackOwnedRuntimeProcess(t, { stackName, envPath: join(baseDir, 'env'), cliHomeDir });
  let requests = 0;
  let reachable = true;
  // Genuine daemon HTTP boundary: use real state selection, PID ownership,
  // reconciliation and presentation rather than replacing their domain owner.
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ping') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-happier-daemon-token'] !== 'fixture-token') {
      res.writeHead(401).end();
      return;
    }
    requests++;
    res.writeHead(reachable ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: reachable }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // Other local port observers may probe this real listener. They must not
  // crash the fixture or count as authenticated daemon observations.
  const unrelated = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(unrelated.status, 404);
  await unrelated.arrayBuffer();
  assert.equal(requests, 0);
  const env = applyStackDaemonLifecycleScopeEnv({ env: process.env, stackName, cliIdentity: 'default' });
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, env });
  await mkdir(join(statePath, '..'), { recursive: true });
  const writeState = pid => writeFile(statePath, JSON.stringify({ pid, httpPort: server.address().port, controlToken: 'fixture-token' }));
  await writeState(child.pid);
  await writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')),
    startedWithRuntimeEntrypoint: '/source/cli/src/index.mjs' }));
  const first = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(first.runtime.components.daemon.status, 'running');
  assert.deepEqual(first.runtime.daemonEntry, { selected: null, loaded: '/source/cli/src/index.mjs' });
  assert.equal(requests, 1, 'one snapshot must not repeat the daemon transport probe');
  await writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')),
    sourceRuntimeReloadRequired: { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'closure_changed' } }));
  const stale = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(stale.runtime.components.daemon.status, 'reload-required');
  assert.equal(stale.runtime.components.daemon.reloadRequired.subtype, 'closure_changed');
  assert.ok(stale.runtime.health.issues.includes('daemon_reload_required'));
  requests = 1;
  reachable = false;
  const second = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(second.runtime.components.daemon.status, 'unreachable');
  assert.deepEqual(second.runtime.daemonEntry, { selected: null, loaded: null });
  assert.equal(requests, 2, 'the next snapshot must obtain fresh daemon evidence');
  await writeState(process.pid);
  await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
  assert.equal(requests, 2, 'foreign daemon state must not receive a control token or be sampled before ownership proof');
});

test('stack info preserves remote execution identity when transport is unknown and exposes preparation phase', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-truth' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=1\nHAPPIER_STACK_SERVE_UI=0\n');
  const runtimePath = join(fixture.stackDir, 'stack.runtime.json');
  const identity = { selected: 'retained-daemon', loaded: 'retained-daemon' };
  for (const phase of ['tunnel', 'bootstrap']) {
    await writeFile(runtimePath, JSON.stringify({ stackName: fixture.stackName,
      sourceRuntimeIdentities: {}, placement: { daemon: 'linux1' },
      remoteTargets: { linux1: { services: { daemon: true }, status: 'retrying', phase,
        serviceStatus: { daemon: 'retrying' }, sourceRuntimeIdentities: { daemon: identity } } },
    }));
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.components.daemon.status, 'unknown');
    assert.equal(out.runtime.components.daemon.phase, phase);
    assert.deepEqual(out.runtime.sourceRuntimeIdentities.daemon, identity);
    assert.ok(out.runtime.health.issues.includes('daemon_unknown'));
    assert.equal(out.runtime.health.issues.includes('daemon_down'), false);
    assert.notEqual(out.runtime.health.status, 'stopped', 'transport loss cannot prove remote retirement');
  }
  await writeFile(runtimePath, JSON.stringify({ stackName: fixture.stackName,
    sourceRuntimeIdentities: {}, placement: { daemon: 'linux1' },
    remoteTargets: { linux1: { services: { daemon: true }, status: 'stopped', serviceStatus: { daemon: 'stopped' },
      sourceRuntimeIdentities: { daemon: identity } } },
  }));
  const stopped = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(stopped.runtime.components.daemon.status, 'stopped');
  assert.equal(stopped.runtime.sourceRuntimeIdentities.daemon.loaded, null);
  assert.equal(stopped.runtime.health.status, 'stopped');
});

test('stack info refuses old healthy HTTP as replacement readiness until the selected source identity is loaded', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'replacement-truth' });
  const envPath = join(fixture.stackDir, 'env');
  const server = await spawnStackOwnedHealthServer(t, { stackName: fixture.stackName, envPath,
    cliHomeDir: join(fixture.stackDir, 'cli') });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(envPath, 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\n');
  const state = { stackName: fixture.stackName, ownerPid: server.pid,
    processes: { serverPid: server.pid }, ports: { server: server.port },
    sourceRuntimeIdentities: { server: { selected: 'replacement', loaded: 'incumbent' } } };
  const statePath = join(fixture.stackDir, 'stack.runtime.json');
  await writeFile(statePath, JSON.stringify(state));
  const pending = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(pending.runtime.components.server.running, true, 'the incumbent still serves healthy HTTP');
  assert.equal(pending.runtime.health.status, 'degraded');
  assert.ok(pending.runtime.health.issues.includes('runtime_identity_pending'));
  state.sourceRuntimeIdentities.server.loaded = 'replacement';
  await writeFile(statePath, JSON.stringify(state));
  const ready = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(ready.runtime.health.status, 'healthy');
  assert.equal(ready.runtime.health.issues.includes('runtime_identity_pending'), false);
  await mkdir(join(fixture.stackDir, 'source-runtime'), { recursive: true });
  await writeFile(join(fixture.stackDir, 'source-runtime/reload.json'), JSON.stringify({ status: 'preparing' }));
  const preparation = await beginPendingSourceStart({ stackBaseDir: fixture.stackDir });
  t.after(() => preparation.dispose());
  const preparing = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(preparing.runtime.health.status, 'degraded', 'old healthy HTTP cannot complete a pending replacement build');
  assert.ok(preparing.runtime.health.issues.includes('runtime_preparing'));
  await preparation.setPhase({ phase: 'failed', component: 'server' });
  const waitingForInput = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(waitingForInput.runtime.health.status, 'healthy', 'reload diagnostics cannot override failed preparation');
  assert.equal(waitingForInput.runtime.health.issues.includes('runtime_preparing'), false);
  await preparation.dispose();
  for (const status of ['ready', 'failed']) {
    await writeFile(join(fixture.stackDir, 'source-runtime/reload.json'), JSON.stringify({ status }));
    const settled = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(settled.runtime.sourceReload.status, status);
    assert.equal(settled.runtime.health.status, 'healthy', 'a settled preparation must not degrade the verified loaded incumbent');
    assert.equal(settled.runtime.health.issues.includes('runtime_preparing'), false);
  }
});

test('stack info projects pending source queue and build phases and retires them with their request', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'preparation-phase' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\n');
  const pending = await beginPendingSourceStart({ stackBaseDir: fixture.stackDir });
  t.after(() => pending.dispose());
  const initial = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(initial.runtime.sourcePreparation?.phase, 'preparing');
  assert.equal(initial.runtime.health.status, 'preparing', 'a live preparation is not a stopped stack');
  for (const phase of ['queued', 'building', 'checking']) {
    await pending.setPhase({ phase, component: 'server' });
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.deepEqual(out.runtime.sourcePreparation, { phase, component: 'server' });
  }
  await pending.setPhase({ phase: 'building', component: 'server' }, 'server-host');
  await pending.setPhase({ phase: 'queued', component: 'daemon' }, 'daemon-host');
  const remote = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.deepEqual(remote.runtime.sourcePreparation.targets, { 'server-host': { phase: 'building', component: 'server' },
    'daemon-host': { phase: 'queued', component: 'daemon' } });
  await pending.setPhase({ phase: 'failed', component: 'server' });
  await pending.setPhase({ phase: 'failed', component: 'server' }, 'server-host');
  await pending.setPhase({ phase: 'failed', component: 'daemon' }, 'daemon-host');
  const failed = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(failed.runtime.sourcePreparation, null, 'a failed preparation waiting for edits is not preparing');
  assert.notEqual(failed.runtime.health.status, 'preparing');
  assert.equal(failed.runtime.health.issues.includes('runtime_preparing'), false);
  await pending.publish(async () => {});
  const settled = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(settled.runtime.sourcePreparation, null);
  assert.equal(settled.runtime.health.status, 'stopped');
  await writeFile(join(fixture.stackDir, 'source-runtime/start.pending.json'), JSON.stringify({ pid: 2147483647, phase: 'building' }));
  const abandoned = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(abandoned.runtime.sourcePreparation, null, 'an absent requester cannot claim active preparation');
});

test('status does not project a server endpoint when listener ownership discovery is inconclusive', async () => {
  const result = await resolveStackComponentRuntime({
    port: 43123,
    recordedPid: 2222,
    runtimePidAlive: true,
    stackName: 'status-test',
    envPath: '/tmp/status-test/env',
    listListenPidsWithStatusImpl: async () => ({
      status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout',
    }),
    isTcpPortListeningImpl: async () => true,
  });

  assert.equal(result.running, false);
  assert.equal(result.ownershipStatus, 'unknown');
  assert.equal(result.listenerDiscoveryStatus, 'timeout');
});

async function withListeningServer() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? Number(addr.port) : 0;
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function withHappierHealthServer({ host = '127.0.0.1', healthDelayMs = 0, onHealthResponse = null, metroStatus = false } = {}) {
  const server = http.createServer((req, res) => {
    if (metroStatus && req.url === '/status') {
      res.writeHead(200).end('packager-status:running');
      return;
    }
    if (req.url === '/health' || req.url === '/ready') {
      const respond = () => {
        onHealthResponse?.();
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      };
      if (healthDelayMs > 0) {
        setTimeout(respond, healthDelayMs);
      } else {
        respond();
      }
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? Number(addr.port) : 0;
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function reserveUnusedPort() {
  const listener = await withListeningServer();
  const port = listener.port;
  await listener.close();
  return port;
}

async function waitForProcessAlive(pid, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`timed out waiting for pid ${pid}`);
}

async function spawnStackOwnedRuntimeProcess(t, { stackName, envPath, cliHomeDir }) {
  const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
  });
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(child.pid);
  return child;
}

async function spawnStackOwnedHealthServer(t, { stackName, envPath, cliHomeDir }) {
  const child = spawnDetachedInlineNodeTestProcess(`
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ready') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    setInterval(() => {}, 1000);
  `, {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const value = Number(output.split(/\r?\n/).find(Boolean));
      if (Number.isInteger(value) && value > 0) resolve(value);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`stack-owned health server exited early (${code ?? 'unknown'})`)));
  });
  return { child, pid: child.pid, port };
}

test('readStackInfoSnapshot observes the recorded dev proxy with a candidate-bounded listener lookup', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-owner-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-proxy-owner';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const listener = await withHappierHealthServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  const proxyProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server-proxy',
    },
  });
  t.after(() => {
    try {
      process.kill(-proxyProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(proxyProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: proxyProcess.pid,
      processes: {
        proxyPid: proxyProcess.pid,
        serverPid: 999_999_999,
      },
      ports: { server: listener.port },
      serverProxy: { enabled: true, mode: 'proxy' },
      serverLifecycle: {
        phase: 'maintenance',
        planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 4 },
        retry: null,
        disposition: null,
      },
    }) + '\n',
    'utf-8',
  );

  const observations = [];
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (_port, options) => {
        observations.push(options?.candidatePids ?? null);
        return options?.candidatePids?.includes(proxyProcess.pid)
          ? { status: 'ok', supported: true, pids: [proxyProcess.pid] }
          : {
              status: 'timeout',
              supported: true,
              pids: [],
              reason: 'listener-discovery-timeout',
            };
      },
    });

    assert.equal(out.runtime.components.server.pid, proxyProcess.pid);
    assert.equal(out.runtime.components.server.pidAlive, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.ownershipStatus, 'owned');
    assert.equal(out.runtime.serverLifecycle?.phase, 'maintenance');
    assert.equal(out.runtime.health.status, 'healthy');
    assert.deepEqual(out.runtime.health.issues, []);
    assert.deepEqual(observations, [[proxyProcess.pid]]);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot gives listener discovery a load-tolerant budget after server endpoint verification', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-observation-budget-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-proxy-observation-budget';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  let now = Date.now();
  const listener = await withHappierHealthServer({
    healthDelayMs: 120,
    onHealthResponse: () => { now += 120; },
  });

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  const proxyProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server-proxy',
    },
  });
  t.after(() => {
    try {
      process.kill(-proxyProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(proxyProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: proxyProcess.pid,
      processes: {
        proxyPid: proxyProcess.pid,
        serverPid: 999_999_999,
      },
      ports: { server: listener.port },
      serverProxy: { enabled: true, mode: 'proxy' },
    }) + '\n',
    'utf-8',
  );

  const observations = [];
  const observationBudgets = [];
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    // Observe the exact budget against a controlled wall clock. Health work
    // advances it, while incidental scheduling between scope creation and
    // the first listener observation must not consume a fixture millisecond.
    t.mock.method(Date, 'now', () => now);
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (_port, options) => {
        observations.push(options?.candidatePids ?? null);
        observationBudgets.push(options?.timeoutMs ?? null);
        return options?.timeoutMs >= 5_000 && options?.candidatePids?.includes(proxyProcess.pid)
          ? { status: 'ok', supported: true, pids: [proxyProcess.pid] }
          : { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
      },
    });

    assert.equal(out.runtime.components.server.ownershipStatus, 'owned');
    assert.equal(out.runtime.health.status, 'healthy');
    assert.deepEqual(observations, [[proxyProcess.pid]]);
    assert.deepEqual(observationBudgets, [5_000]);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot degrades health when only the maintenance proxy remains after a terminal server failure', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-unavailable-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-proxy-unavailable';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const listener = await withListeningServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  const proxyProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server-proxy',
    },
  });
  t.after(() => {
    try {
      process.kill(-proxyProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(proxyProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: proxyProcess.pid,
      processes: {
        proxyPid: proxyProcess.pid,
        serverPid: null,
        serverWrapperPid: null,
        serverBackendPid: null,
        serverDrainingPid: null,
      },
      ports: { server: listener.port, serverBackend: null },
      serverProxy: { enabled: true, mode: 'proxy' },
      serverLifecycle: {
        phase: 'unavailable',
        planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 4 },
        retry: null,
        disposition: { code: 'restart_failed' },
      },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (_port, options) => (
        options?.candidatePids?.includes(proxyProcess.pid)
          ? { status: 'ok', supported: true, pids: [proxyProcess.pid] }
          : { status: 'ok', supported: true, pids: [] }
      ),
    });

    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.server.pid, proxyProcess.pid);
    assert.equal(out.runtime.serverLifecycle?.phase, 'unavailable');
    assert.equal(out.runtime.serverLifecycle?.disposition?.code, 'restart_failed');
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot degrades health while a maintenance proxy is listening without a healthy backend', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-proxy-backend-missing-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-proxy-backend-missing';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const listener = await withListeningServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  const proxyProcess = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server-proxy',
    },
  });
  t.after(() => {
    try {
      process.kill(-proxyProcess.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  });
  await waitForProcessAlive(proxyProcess.pid);
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: proxyProcess.pid,
      processes: {
        proxyPid: proxyProcess.pid,
        serverPid: null,
        serverBackendPid: null,
      },
      ports: { server: listener.port, serverBackend: null },
      serverProxy: { enabled: true, mode: 'proxy' },
      serverLifecycle: {
        phase: 'maintenance',
        planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
        lastCompleted: { mode: 'exclusiveDb', generation: 4 },
      },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async (_port, options) => (
        options?.candidatePids?.includes(proxyProcess.pid)
          ? { status: 'ok', supported: true, pids: [proxyProcess.pid] }
          : { status: 'ok', supported: true, pids: [] }
      ),
    });

    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.serverBackend.running, false);
    assert.equal(out.runtime.serverLifecycle?.phase, 'maintenance');
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running from an untrusted live infra pid', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-process-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const serverPort = await reserveUnusedPort();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${serverPort}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: process.pid },
      ports: { server: serverPort },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.runningPid, null);
    assert.equal(out.runtime.components.server.pidAlive, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot fails closed without throwing when Windows cannot prove recorded runtime ownership', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-windows-ownership-inconclusive-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-windows-ownership-inconclusive';
  const baseDir = join(storageDir, stackName);
  const listener = await withHappierHealthServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      runtimeSnapshotId: 'snap-windows',
      ownerPid: process.pid,
      processes: { serverPid: process.pid },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platformDescriptor, 'expected process.platform descriptor');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      listListenPidsWithStatusImpl: async () => ({
        status: 'unsupported',
        supported: false,
        pids: [],
        reason: 'missing-listener-discovery-command',
      }),
    });

    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.runningPid, null);
    assert.equal(out.runtime.components.owner.running, false);
    assert.equal(out.runtime.components.server.pidAlive, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.components.server.ownershipStatus, 'unverified');
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.equal(out.urls.internalServerUrl, null);
    assert.equal(out.runtime.health.status, 'stopped');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running when only an unrelated server port is occupied', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-port-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const listener = await withListeningServer();
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${listener.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.runningPid, null);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not adopt a healthy wildcard-bound endpoint from stale runtime state', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-running-health-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);

  await mkdir(baseDir, { recursive: true });

  const listener = await withHappierHealthServer({ host: '0.0.0.0' });
  await writeFile(
    join(baseDir, 'env'),
    `HAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      runtimeSnapshotId: 'snap-stale',
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.components.server.portListening, true);
    assert.equal(out.runtime.health.status, 'stopped');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.equal(out.urls.internalServerUrl, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot keeps a live owner\'s recorded snapshot identity while its server endpoint is not yet verified', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-non-listening-snapshot-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-non-listening-snapshot';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(baseDir, { recursive: true });
  const foreignListener = await withHappierHealthServer();
  const runtimeProcess = await spawnStackOwnedRuntimeProcess(t, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_PORT=${foreignListener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      runtimeSnapshotId: 'snap-stale',
      ownerPid: runtimeProcess.pid,
      processes: { serverPid: runtimeProcess.pid },
      ports: { server: foreignListener.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.loadedSnapshotId, 'snap-stale');
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['server_down']);
    assert.equal(out.urls.internalServerUrl, null);
  } finally {
    restore();
    await foreignListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('QA browser selects fresh Stack-info endpoints after borrowed UI and server ports change', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-browser-current-endpoints-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const stackName = 'browser-current-endpoints';
  const producerName = 'browser-expo-producer';
  const baseDir = join(tmp, stackName);
  const producerDir = join(tmp, producerName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir);
  await mkdir(producerDir);
  const firstServer = await spawnStackOwnedHealthServer(t, { stackName, envPath, cliHomeDir: join(baseDir, 'cli') });
  const secondServer = await spawnStackOwnedHealthServer(t, { stackName, envPath, cliHomeDir: join(baseDir, 'cli') });
  const metros = await Promise.all([withHappierHealthServer({ metroStatus: true }), withHappierHealthServer({ metroStatus: true })]);
  for (const metro of metros) t.after(() => metro.close());
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${firstServer.port}\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_EXPO_SOURCE_STACK=${producerName}\n`);
  await writeFile(join(producerDir, 'env'), 'HAPPIER_STACK_DAEMON=0\n');
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: tmp,
    HAPPIER_STACK_ENV_FILE: join(tmp, 'foreign-stack', 'env') });
  t.after(restore);
  let previous;
  for (const [index, server] of [firstServer, secondServer].entries()) {
    await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({ stackName,
      ownerPid: server.pid, processes: { serverPid: server.pid }, ports: { server: server.port },
      sourceRuntimeIdentities: {}, sourceUi: 'borrowed' }));
    await writeFile(join(producerDir, 'stack.runtime.json'), JSON.stringify({ stackName: producerName,
      script: 'dev.mjs', processes: {}, expo: { webPort: metros[index].port, webEnabled: true } }));
    const info = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(info.ports.server, server.port);
    assert.equal(info.pinned.serverPort, firstServer.port);
    const selected = resolveQaBrowserUrl(undefined, [], info);
    assert.equal(selected, info.urls.uiUrl);
    const url = new URL(selected);
    assert.equal(url.port, String(metros[index].port));
    assert.equal(new URL(url.searchParams.get('server')).port, String(server.port));
    assert.equal(url.searchParams.get('happier_hmr'), '0');
    if (previous) {
      assert.notEqual(selected, previous, 'a new invocation must not retain the old ingress');
      assert.equal(resolveQaBrowserUrl(previous, [], info), previous, 'an explicit diagnostic URL remains caller-selected');
    }
    previous = selected;
  }
  assert.throws(() => resolveQaBrowserUrl(undefined, [], { urls: { uiUrl: null } }), /no current UI endpoint/);
});

test('readStackInfoSnapshot projects the owned runtime port when a foreign pinned endpoint disagrees', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-mismatched-server-port-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-mismatched-server-port';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(baseDir, { recursive: true });
  const foreignListener = await withHappierHealthServer();
  const runtimeServer = await spawnStackOwnedHealthServer(t, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  });
  await writeFile(
    envPath,
    `HAPPIER_STACK_STACK=${stackName}\nHAPPIER_STACK_SERVER_PORT=${foreignListener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeServer.pid,
      processes: { serverPid: runtimeServer.pid },
      ports: { server: runtimeServer.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, {
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_ENV_FILE: join(storageDir, 'foreign-stack', 'env'),
  });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(), stackName,
      // A later bounded diagnostic can be inconclusive without invalidating the
      // canonical endpoint owner's independent proof of the real owned listener.
      listListenPidsWithStatusImpl: async () => ({ status: 'timeout', supported: true, pids: [] }),
    });
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.urls.internalServerUrl, `http://127.0.0.1:${runtimeServer.port}`);
    assert.equal(out.ports.server, runtimeServer.port);
    assert.equal(out.pinned.serverPort, foreignListener.port);
  } finally {
    restore();
    await foreignListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot does not report running from a foreign healthy dev-proxy backend', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-foreign-backend-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-foreign-backend';
  const baseDir = join(storageDir, stackName);
  const listener = await withHappierHealthServer();

  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_DAEMON=0\n', 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: 999_999_999,
      processes: { serverBackendPid: 999_999_998 },
      ports: { serverBackend: listener.port },
      serverProxy: { enabled: true, mode: 'proxy' },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.components.serverBackend.running, false);
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.health.status, 'stopped');
  } finally {
    restore();
    await listener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot exposes the server-served web UI when a runtime snapshot is active and Expo is absent', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-ui' });
  const envPath = join(fixture.stackDir, 'env');
  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName: fixture.stackName,
    envPath,
    cliHomeDir: join(fixture.stackDir, 'cli'),
  });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\n`,
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: runtimeProcess.pid,
      runtimeSnapshotId: 'snap-1',
      processes: { serverPid: runtimeProcess.pid },
      ports: { server: runtimeProcess.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, true);
    assert.equal(out.ports.ui, runtimeProcess.port);
    assert.ok(out.urls.uiUrl && out.urls.uiUrl.includes(`:${runtimeProcess.port}`), `expected uiUrl to include server port\nuiUrl=${out.urls.uiUrl}`);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot distinguishes the selected snapshot from the loaded snapshot until manual restart', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-manual-restart' });
  const selectedManifestPath = join(fixture.snapshotDir, 'manifest.json');
  const selectedManifest = JSON.parse(await readFile(selectedManifestPath, 'utf8'));
  await writeFile(selectedManifestPath, JSON.stringify({ ...selectedManifest,
    source: { ...selectedManifest.source, dbProvider: 'mysql' } }));
  const loadedSnapshotDir = join(fixture.stackDir, 'runtime', 'builds', 'snap-loaded');
  await mkdir(loadedSnapshotDir, { recursive: true });
  await writeFile(join(loadedSnapshotDir, 'manifest.json'), JSON.stringify({ ...selectedManifest,
    snapshotId: 'snap-loaded', source: { ...selectedManifest.source, dbProvider: 'postgres' } }));
  const envPath = join(fixture.stackDir, 'env');
  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName: fixture.stackName,
    envPath,
    cliHomeDir: join(fixture.stackDir, 'cli'),
  });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\nHAPPIER_STACK_RUNTIME_MODE=require\n`,
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: runtimeProcess.pid,
      runtimeSnapshotId: 'snap-loaded',
      processes: { serverPid: runtimeProcess.pid },
      ports: { server: runtimeProcess.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.selectedSnapshotId, 'snap-1');
    assert.equal(out.runtime.loadedSnapshotId, 'snap-loaded');
    assert.equal(out.runtime.pendingManualRestart, true);
    assert.equal(out.runtime.mode, 'require');
    assert.equal(out.database.provider, 'postgres', 'loaded provider wins over both configuration and a newer selected snapshot');
    assert.equal(out.database.basis, 'loaded-runtime-snapshot');
  } finally {
    restore();
  }
});

test('stack info reads loaded native database identity on its runtime host', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-native-db' });
  const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh',
    repoDir: fileURLToPath(new URL('../../../', import.meta.url)), cliHomeDir: join(fixture.root, 'worker', 'cli') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: fixture.stackName, runtimeMode: 'source-snapshot' });
  const env = 'HAPPIER_STACK_RUNTIME_MODE=require\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\nHAPPIER_DB_PROVIDER=sqlite\n';
  await mkdir(paths.stackBaseDir, { recursive: true });
  await writeFile(paths.stackEnvPath, env);
  await writeFile(join(fixture.stackDir, 'env'), env);
  const loadedDir = join(paths.stackBaseDir, 'runtime', 'builds', 'snap-loaded');
  await mkdir(loadedDir, { recursive: true });
  await writeFile(join(loadedDir, 'manifest.json'), JSON.stringify({ snapshotId: 'snap-loaded', source: { dbProvider: 'postgres' } }));
  const server = await spawnStackOwnedHealthServer(t, { stackName: fixture.stackName,
    envPath: paths.stackEnvPath, cliHomeDir: paths.cliHomeDir });
  await writeFile(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
    ownerPid: server.pid, runtimeSnapshotId: 'snap-loaded', processes: { serverPid: server.pid }, ports: { server: server.port } }));
  await writeFile(join(fixture.stackDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target],
    runtimePlacement: { server: { mode: 'prefer-target', target: target.name, fallback: 'error' } } }));
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
    placement: { server: target.name }, remoteTargets: { [target.name]: { runtimeMode: 'controlled',
      services: { server: true }, status: 'running', serviceStatus: { server: 'running' } } } }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  let probes = 0;
  const out = await readStackInfoSnapshot({ rootDir: target.repoDir, stackName: fixture.stackName,
    runRemoteProcessImpl: async ({ args }) => {
      probes++;
      const result = await promisify(execFile)('bash', ['-c', args.at(-1)]);
      return { code: 0, out: result.stdout, err: result.stderr };
    } });
  assert.equal(out.database.provider, 'postgres');
  assert.equal(out.database.basis, 'loaded-runtime-snapshot');
  assert.equal(probes, 1, 'one host observation reads the loaded native manifest');
});

test('readStackInfoSnapshot reports the loaded runtime snapshot while its trusted owner is live before a listener is ready', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-owner-starting' });
  const envPath = join(fixture.stackDir, 'env');
  const runtimeProcess = await spawnStackOwnedRuntimeProcess(t, {
    stackName: fixture.stackName,
    envPath,
    cliHomeDir: join(fixture.stackDir, 'cli'),
  });
  await writeFile(
    envPath,
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_RUNTIME_MODE=require\n',
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: runtimeProcess.pid,
      runtimeSnapshotId: 'snap-1',
      processes: { serverPid: runtimeProcess.pid },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.selectedSnapshotId, 'snap-1');
    assert.equal(out.runtime.loadedSnapshotId, 'snap-1');
    assert.equal(out.runtime.pendingManualRestart, false);
    assert.equal(out.runtime.buildSourceFingerprint, 'src-build-1');
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot does not report a manual runtime restart for a running source process', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-source-to-selected' });
  const envPath = join(fixture.stackDir, 'env');
  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName: fixture.stackName,
    envPath,
    cliHomeDir: join(fixture.stackDir, 'cli'),
  });
  await writeFile(
    envPath,
    `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\n`,
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: runtimeProcess.pid,
      processes: { serverPid: runtimeProcess.pid },
      ports: { server: runtimeProcess.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.selectedSnapshotId, 'snap-1');
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.equal(out.runtime.pendingManualRestart, false);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot borrows Expo from its configured producer without claiming process ownership', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-borrowed-expo' });
  const envPath = join(fixture.stackDir, 'env');
  const runtimeServer = await spawnStackOwnedHealthServer(t, {
    stackName: fixture.stackName,
    envPath,
    cliHomeDir: join(fixture.stackDir, 'cli'),
  });
  await writeFile(
    envPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_SERVER_PORT=${runtimeServer.port}`,
      'HAPPIER_STACK_RUNTIME_MODE=require',
      'HAPPIER_STACK_EXPO_SOURCE_STACK=repo-producer',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: runtimeServer.pid,
      runtimeSnapshotId: 'snap-1',
      processes: { serverPid: runtimeServer.pid },
      ports: { server: runtimeServer.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName: fixture.stackName,
      resolveBorrowedExpoRuntimeImpl: async () => ({
        producerStackName: 'repo-producer',
        ownership: 'borrowed',
        running: true,
        status: 'running',
        port: 19364,
        mobilePort: 19364,
        devClientEnabled: true,
        source: 'remote_target',
        remoteTarget: 'mac',
      }),
    });

    assert.equal(out.runtime.components.ui.running, true);
    assert.equal(out.runtime.components.ui.pid, null);
    assert.equal(out.runtime.components.ui.ownership, 'borrowed');
    assert.equal(out.runtime.components.ui.producerStackName, 'repo-producer');
    assert.equal(out.runtime.components.ui.remoteTarget, 'mac');
    assert.equal(out.runtime.borrowedExpo.producerStackName, 'repo-producer');
    assert.equal(out.ports.ui, 19364);
    assert.equal(out.ports.mobile, 19364);
    assert.match(out.urls.uiUrl, /happier-runtime-borrowed-expo\.localhost:19364/);
    const borrowedUiUrl = new URL(out.urls.uiUrl);
    assert.equal(
      borrowedUiUrl.searchParams.get('server'),
      `http://happier-runtime-borrowed-expo.localhost:${runtimeServer.port}`,
    );
    assert.equal(borrowedUiUrl.searchParams.get('happier_hmr'), '0');
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot does not treat borrowed Expo as a running consumer stack', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-borrowed-expo-stopped' });
  await writeFile(
    join(fixture.stackDir, 'env'),
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      'HAPPIER_STACK_RUNTIME_MODE=require',
      'HAPPIER_STACK_EXPO_SOURCE_STACK=repo-producer',
      '',
    ].join('\n'),
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName: fixture.stackName,
      resolveBorrowedExpoRuntimeImpl: async () => ({
        producerStackName: 'repo-producer',
        ownership: 'borrowed',
        running: true,
        status: 'running',
        port: 19364,
        mobilePort: 19364,
        devClientEnabled: true,
        source: 'remote_target',
        remoteTarget: 'mac',
      }),
    });

    assert.equal(out.runtime.components.ui.running, true);
    assert.equal(out.runtime.components.ui.ownership, 'borrowed');
    assert.equal(out.runtime.borrowedExpo.running, true);
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.health.status, 'stopped');
    assert.deepEqual(out.runtime.health.issues, []);
    assert.equal(out.runtime.selectedSnapshotId, 'snap-1');
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.equal(out.runtime.pendingManualRestart, false);
  } finally {
    restore();
  }
});

for (const scenario of [
  {
    name: 'environment-disabled',
    envLine: 'HAPPIER_STACK_SERVE_UI=0',
    runtimeServeUi: undefined,
  },
  {
    name: 'launch-disabled',
    envLine: '',
    runtimeServeUi: false,
  },
]) {
  test(`readStackInfoSnapshot keeps runtime-backed UI disabled for ${scenario.name} truth despite stale live Expo metadata`, async (t) => {
    const fixture = await createRuntimeSnapshotFixture(t, { stackName: `runtime-ui-${scenario.name}` });
    const listener = await withHappierHealthServer();
    const staleUiPort = await reserveUnusedPort();
    await writeFile(
      join(fixture.stackDir, 'env'),
      [
        'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
        `HAPPIER_STACK_SERVER_PORT=${listener.port}`,
        'HAPPIER_STACK_DAEMON=0',
        scenario.envLine,
        '',
      ].filter((line) => line !== '').join('\n') + '\n',
      'utf-8',
    );
    await writeFile(
      join(fixture.stackDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName: fixture.stackName,
        ownerPid: 999_999_999,
        runtimeSnapshotId: 'snap-1',
        ...(typeof scenario.runtimeServeUi === 'boolean' ? { serveUi: scenario.runtimeServeUi } : {}),
        processes: { serverPid: 999_999_998, expoPid: process.pid },
        ports: { server: listener.port },
        expo: { webPort: staleUiPort, webEnabled: true },
      }) + '\n',
      'utf-8',
    );

    const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
    try {
      const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
      assert.equal(out.runtime.components.ui.running, false);
      assert.equal(out.runtime.components.ui.pid, null);
      assert.equal(out.ports.ui, null);
      assert.equal(out.urls.uiUrl, null);
      assert.equal(out.runtime.health.issues.includes('ui_down'), false);
    } finally {
      restore();
      await listener.close();
    }
  });
}

test('readStackInfoSnapshot marks UI as down when expo runtime metadata is stale', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-stale-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(baseDir, { recursive: true });

  const staleUiPort = await reserveUnusedPort();
  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  });
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeProcess.pid,
      processes: { serverPid: runtimeProcess.pid, expoPid: 999_999_998 },
      ports: { server: runtimeProcess.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
    assert.equal(out.ports.ui, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot requires UI port reachability even when expo pid is alive', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-unreachable-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(baseDir, { recursive: true });

  const staleUiPort = await reserveUnusedPort();
  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  });
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeProcess.pid,
      processes: { serverPid: runtimeProcess.pid, expoPid: process.pid },
      ports: { server: runtimeProcess.port },
      expo: { webPort: staleUiPort, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.ui.pidAlive, false);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
    assert.equal(out.ports.ui, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot rejects stale Expo UI metadata when an unrelated process occupies the UI port', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-ui-port-collision-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(baseDir, { recursive: true });

  const unrelatedUiListener = await withListeningServer();
  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  });
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeProcess.pid,
      processes: { serverPid: runtimeProcess.pid, expoPid: 999_999_998 },
      ports: { server: runtimeProcess.port },
      expo: { webPort: unrelatedUiListener.port, webEnabled: true },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.ui.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['ui_down', 'daemon_down']);
    assert.equal(out.ports.ui, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await unrelatedUiListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot marks daemon as down when stack runtime is otherwise running and daemon is expected', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-daemon-down-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-auth';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(baseDir, { recursive: true });

  const runtimeProcess = await spawnStackOwnedHealthServer(t, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  });
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${runtimeProcess.port}\n`, 'utf-8');
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeProcess.pid,
      processes: { serverPid: runtimeProcess.pid },
      ports: { server: runtimeProcess.port },
    }) + '\n',
    'utf-8'
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.components.server.running, true);
    assert.equal(out.runtime.components.daemon.running, false);
    assert.equal(out.runtime.health.status, 'degraded');
    assert.deepEqual(out.runtime.health.issues, ['daemon_down']);
  } finally {
    restore();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readStackInfoSnapshot treats running target-hosted Expo and daemon services as remote instead of missing local pids', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-info-remote-daemon-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'dev-remote-daemon';
  const baseDir = join(storageDir, stackName);
  const serverListener = await withHappierHealthServer();
  const metroListener = await withHappierHealthServer({ metroStatus: true });

  await mkdir(baseDir, { recursive: true });
  await writeFile(
    join(baseDir, 'env'),
    `HAPPIER_STACK_SERVER_PORT=${serverListener.port}\nHAPPIER_STACK_DAEMON=1\n`,
    'utf-8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: null,
      processes: { serverPid: null, daemonPid: 111, daemonPids: [111] },
      ports: { server: serverListener.port },
      expo: {
        port: metroListener.port,
        webPort: metroListener.port,
        webEnabled: true,
        remoteTarget: 'mac',
      },
      placement: { server: 'local', expo: 'mac', daemon: 'mac' },
      remoteTargets: {
        mac: {
          services: { server: false, expo: true, daemon: true },
          status: 'running',
        },
      },
    }) + '\n',
    'utf-8',
  );
  const runtimeStateBefore = await readFile(join(baseDir, 'stack.runtime.json'), 'utf-8');

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });
  try {
    const out = await readStackInfoSnapshot({
      rootDir: process.cwd(),
      stackName,
      // This case exercises remote-daemon placement, not OS process ownership.
      isPidOwnedByStackImpl: async () => true,
    });
    assert.equal(out.runtime.running, true);
    assert.equal(out.runtime.health.status, 'healthy');
    assert.deepEqual(out.runtime.health.issues, []);
    assert.equal(out.runtime.components.daemon.status, 'running');
    assert.equal(out.runtime.components.ui.running, true);
    assert.equal(out.runtime.components.ui.source, 'remote_target');
    assert.equal(out.runtime.components.ui.remoteTarget, 'mac');
    assert.deepEqual(out.runtime.placement, { server: 'local', expo: 'mac', daemon: 'mac' });
    assert.equal(out.runtime.remoteTargets.mac.status, 'running');
    assert.equal(
      await readFile(join(baseDir, 'stack.runtime.json'), 'utf-8'),
      runtimeStateBefore,
      'read-only stack info must not reconcile local daemon state for a remotely placed daemon',
    );
  } finally {
    restore();
    await serverListener.close();
    await metroListener.close();
    await rm(tmp, { recursive: true, force: true });
  }
});


test('stack info JSON, human output and READY reject the daemon published closure refusal', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'closure-refusal' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=1\nHAPPIER_STACK_SERVE_UI=0\n');
  const reloadRequired = { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'closure_changed' };
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ stackName: fixture.stackName,
    sourceRuntimeIdentities: {}, placement: { daemon: 'worker' }, remoteTargets: { worker: {
      services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' },
      sourceRuntimeIdentities: { daemon: { selected: 'same', loaded: 'same', reloadRequired } },
    } } }));
  const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(out.runtime.components.daemon.status, 'reload-required');
  assert.deepEqual(out.runtime.sourceRuntimeIdentities.daemon, { selected: 'same', loaded: null, reloadRequired });
  const { projectStackReloadVerification } = await import('./stack/reload_verdict.mjs');
  const verdictInfo = { ...out, runtime: { ...out.runtime, running: true, valid: true,
    sourceRuntimeIdentities: { server: { selected: 'server', loaded: 'server' }, ...out.runtime.sourceRuntimeIdentities } } };
  assert.equal(projectStackReloadVerification({ info: verdictInfo }).check, 'identity:daemon');
  const info = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./stack_commands.mjs', import.meta.url)), 'info', fixture.stackName], {
      signal: t.signal,
      env: buildStackFixtureEnv({ stripStackEnv: true, homeDir: join(fixture.storageDir, 'home'), storageDir: fixture.storageDir,
        extraEnv: { HAPPIER_STACK_REPO_DIR: process.cwd(), HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
          HAPPIER_STACK_UPDATE_CHECK: '0', HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' } }),
    });
  assert.match(info.stdout, /daemon: reload-required/);
});


test('live remote status preserves the target daemon reload decision', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-closure-refusal' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh', repoDir: process.cwd(),
    cliHomeDir: join(fixture.stackDir, 'worker-home') };
  await writeFile(join(fixture.stackDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target] }));
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=1\nHAPPIER_STACK_SERVE_UI=0\n');
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ stackName: fixture.stackName,
    sourceRuntimeIdentities: {}, placement: { daemon: 'worker' }, remoteTargets: { worker: {
      runtimeMode: 'source-snapshot', services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' },
      sourceRuntimeIdentities: { daemon: { selected: 'same', loaded: 'same' } },
    } } }));
  const reloadRequired = { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'closure_changed' };
  // SSH is the process/network boundary; the real status parser and projection run beneath it.
  const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    observeRemoteSourceRuntime: true, runRemoteProcessImpl: async () => ({ code: 0, out: JSON.stringify({
      serviceStatus: { daemon: 'reload-required' },
      sourceRuntimeIdentities: { daemon: { selected: 'same', loaded: null, reloadRequired } },
    }) }) });
  assert.equal(out.runtime.components.daemon.status, 'reload-required');
  assert.deepEqual(out.runtime.sourceRuntimeIdentities.daemon, { selected: 'same', loaded: null, reloadRequired });
});
