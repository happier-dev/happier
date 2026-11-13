import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp, chmod, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { resolveServerReadyTimeoutMs } from './utils/server/server.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';
import { readStackDaemonParticipants } from './stack/daemon_participants.mjs';
import { createHappyCliReloadExecutor } from './utils/dev/daemon.mjs';
import { recordSourceReloadRefusal } from './runtime/shared/source_reload_refusal.mjs';

import {
  checkDaemonState,
  checkDaemonStatePingAware,
  DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS,
  matchDaemonEnvLine,
  resolveAttendedStartupTimeoutMs,
  resolveStackDaemonStartVerifyTimeoutMs,
  shouldContinueDaemonStartVerification,
  startLocalDaemonWithAuth,
} from './daemon.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess, spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import {
  writeStubCliDistBuildManifest,
  writeStubHappierCliFiles,
} from './testkit/core/stub_happier_cli_files.mjs';
import { buildStubHappierServerSetSource } from './testkit/core/stub_happier_cli_server_set.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';
import { inspectDependencyRefresh } from './utils/proc/dependency_refresh.mjs';
import { DaemonControlPostError } from './utils/stack/daemonControlClient.mjs';
import { readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);
const DAEMON_TEST_PROCESS_HELPER_PATH = join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs');
const PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS = '15000';

for (const scenario of ['default', 'broker', 'reload-identities', 'adopt-identities']) {
const identity = scenario.endsWith('identities') ? 'default' : scenario;
test(`source restart gives the ${scenario} successor the stack-owned server URLs before create-path attestation`, async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-control-', registerCleanup: false });
  const cliHomeDir = fixture.path(identity === 'default' ? 'cli' : `cli-identities/${identity}`);
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'fixture-credential\n');
  const stackName = 'source-control-reload';
  const statePath = join(cliHomeDir, 'servers', `stack_${stackName}__id_${identity}`, 'daemon.state.json');
  const runtimeStatePath = scenario === 'adopt-identities'
    ? fixture.path(stackName, 'stack.runtime.json') : fixture.path('stack.runtime.json');
  const requestPath = fixture.path('request.json');
  const incumbent = fixture.path('incumbent.mjs');
  const selected = scenario === 'adopt-identities'
    ? fixture.path('adopted-bundle/apps/cli/src/index.mjs') : fixture.path('selected.mjs');
  const children = [];
  const cleanupStatePaths = [statePath];
  t.after(async () => {
    for (const path of cleanupStatePaths) {
      if (!existsSync(path)) continue;
      const { pid } = JSON.parse(await readFile(path, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await fixture.cleanup();
  });
  let serverUrl = 'http://127.0.0.1:4301';
  if (scenario === 'adopt-identities') {
    const backend = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    serverUrl = 'http://127.0.0.1:' + backend.address().port;
    t.after(() => new Promise(resolve => backend.close(resolve)));
  }
  const publicServerUrl = 'http://source-control-reload.localhost:4301';
  const staleServerUrl = 'http://127.0.0.1:59671';
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }), HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_CLI_IDENTITY: identity,
    HAPPIER_STACK_ENV_FILE: scenario === 'adopt-identities' ? fixture.path(stackName, 'env') : fixture.path('env'),
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_PROCESS_KIND: 'daemon', HAPPIER_SERVER_URL: staleServerUrl,
    HAPPIER_WEBAPP_URL: 'http://stale.localhost:59671',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0', HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS };
  const script = `
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
const statePath = process.env.RELOAD_FIXTURE_STATE_PATH ?? ${JSON.stringify(statePath)};
if (process.argv[2] === 'daemon' && process.argv[3] === 'stop') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const response = await fetch('http://127.0.0.1:' + state.httpPort + '/stop', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-happier-daemon-token': state.controlToken },
    body: JSON.stringify({ stopSessions: true }),
  });
  process.exit(response.ok ? 0 : 1);
}
if (process.argv[2] !== 'daemon' || process.argv[3] !== 'start-sync') process.exit(${scenario === 'adopt-identities' ? 0 : 1});
const server = createServer((req, res) => {
  if (req.headers['x-happier-daemon-token'] !== 'fixture-token') { res.writeHead(401); res.end(); return; }
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ping') { res.end('{"ok":true}'); return; }
    const body = JSON.parse(raw);
    if (req.url === '/restart') writeFileSync(${JSON.stringify(fixture.path('restarts.log'))}, process.env.HAPPIER_STACK_CLI_IDENTITY + '\\n', { flag: 'a' });
    writeFileSync(process.env.RELOAD_FIXTURE_REQUEST_PATH ?? ${JSON.stringify(requestPath)}, JSON.stringify({ path: req.url, body }));
    if (req.url !== '/restart') { res.writeHead(409); res.end('{}'); return; }
    const state = JSON.parse(readFileSync(${JSON.stringify(runtimeStatePath)}, 'utf8'));
    const entrypoint = state.sourceRuntimeIdentities.daemon.selected === 'unloaded' ? ${JSON.stringify(selected)} : state.sourceRuntimeLaunch.entrypoint;
    const staleDataArgs = state.sourceRuntimeIdentities.daemon.selected === 'unloaded' ? [state.sourceRuntimeLaunch.entrypoint] : [];
    const child = spawn(process.execPath, [entrypoint, 'daemon', 'start-sync', ...staleDataArgs], {
      env: {
        ...process.env,
        HAPPIER_SERVER_URL: body.successorServerUrls?.serverUrl ?? process.env.HAPPIER_SERVER_URL,
        HAPPIER_WEBAPP_URL: body.successorServerUrls?.webappUrl ?? process.env.HAPPIER_WEBAPP_URL,
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.end('{"status":"restarting"}');
    res.once('finish', () => server.close());
  });
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ startedWithRuntimeEntrypoint: process.argv[1], pid: process.pid, httpPort: server.address().port, controlToken: 'fixture-token' }));
  process.send?.('ready'); process.disconnect?.();
});
`;
  await writeFile(incumbent, script);
  await mkdir(dirname(selected), { recursive: true });
  await writeFile(selected, script);
  await recordStackRuntimeUpdate(runtimeStatePath, { stackName, processes: {},
    sourceRuntimeLaunch: { entrypoint: incumbent, cliDir: fixture.root },
    sourceRuntimeIdentities: { server: { selected: 'server', loaded: 'server' }, daemon: { selected: 'old', loaded: 'old' } } });
  const runner = spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  children.push(runner);
  const initial = spawnTestProcess(process.execPath, [scenario === 'adopt-identities' ? selected : incumbent, 'daemon', 'start-sync'], {
    env: scenario === 'adopt-identities'
      ? { ...env, HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: serverUrl } : env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(initial);
  await once(initial, 'message');
  const options = { cliBin: incumbent, cliEntrypoint: selected, cliHomeDir,
    internalServerUrl: serverUrl, publicServerUrl, stackName, runtimeStatePath, cliIdentity: identity,
    // The incumbent keeps its old origin; the new connection selects the successor UI.
    env: { ...env, HAPPIER_WEBAPP_URL: publicServerUrl },
    forceRestart: true, preserveSessionsOnRestart: true,
    sourceRuntimeLaunchUpdate: { launch: { entrypoint: selected, cliDir: fixture.root }, identity: 'next' } };
  const reloadPath = fixture.path('source-runtime/reload.json');
  const refusal = Object.assign(new Error('source dependency refresh required'), {
    component: 'daemon', code: 'SOURCE_RUNTIME_RELOAD_REQUIRED',
  });
  await recordSourceReloadRefusal({ stackBaseDir: fixture.root, error: refusal, env });
  if (scenario.endsWith('identities')) {
    const named = ['fixture-a', 'fixture-b'];
    const initialPids = new Map([['default', initial.pid]]);
    for (const name of [...named, 'stale']) {
      const home = fixture.path(`cli-identities/${name}`);
      await mkdir(home, { recursive: true });
      if (name === 'stale') {
        const staleState = join(home, 'servers', `stack_${stackName}__id_${name}`, 'daemon.state.json');
        await mkdir(dirname(staleState), { recursive: true });
        const exited = spawnTestProcess(process.execPath, ['-e', '']);
        await once(exited, 'exit');
        await writeFile(staleState, JSON.stringify({ pid: exited.pid, httpPort: 0 }));
        continue;
      }
      const namedState = join(home, 'servers', `stack_${stackName}__id_${name}`, 'daemon.state.json');
      const child = spawnTestProcess(process.execPath, [incumbent, 'daemon', 'start-sync'], {
        env: { ...env, HAPPIER_HOME_DIR: home, HAPPIER_STACK_CLI_IDENTITY: name,
          RELOAD_FIXTURE_STATE_PATH: namedState, RELOAD_FIXTURE_REQUEST_PATH: join(home, 'request.json') },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      await once(child, 'message');
      initialPids.set(name, child.pid);
      cleanupStatePaths.push(namedState);
    }
    // No named intent entries: reproduce fixture homes surviving stale stack state.
    const executor = createHappyCliReloadExecutor({
      startDaemon: true, cliBin: incumbent, cliHomeDir, internalServerUrl: serverUrl,
      publicServerUrl, stackName, runtimeStatePath, env, sourceRuntimeOptions: {},
    }, {
      // Fixture-supplied compiler output; activation, process control and attestation stay real.
      prepareDevDaemonSourceRuntimeImpl: async () => options.sourceRuntimeLaunchUpdate,
      logger: { log() {}, warn() {} },
    });
    let adoption;
    let adoptionOutput = '';
    if (scenario === 'adopt-identities') {
      const fakeRepo = fixture.path('repo');
      for (const directory of ['node_modules', 'apps/cli/dist', 'apps/ui', 'apps/server']) {
        await mkdir(join(fakeRepo, directory), { recursive: true });
      }
      await writeFile(join(fakeRepo, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }));
      await writeFile(join(fakeRepo, 'pnpm-workspace.yaml'), 'packages: ["apps/*"]');
      for (const component of ['cli', 'ui', 'server']) {
        await writeFile(join(fakeRepo, 'apps', component, 'package.json'),
          JSON.stringify({ name: 'fixture-' + component, private: true }));
      }
      await writeFile(join(fakeRepo, 'apps/cli/dist/index.mjs'), '');
      const bundleDir = fixture.path('adopted-bundle');
      const sourceRoot = fixture.path(stackName, 'source-runtime');
      await mkdir(bundleDir, { recursive: true });
      await mkdir(sourceRoot, { recursive: true });
      const markerPath = fixture.path('dependency-marker.json');
      const generationPath = fixture.path('dependency-generation.json');
      await writeFile(markerPath, JSON.stringify({ identity: 'fixture-dependencies' }));
      await writeFile(generationPath, JSON.stringify({ generation: 1, completedGeneration: 1 }));
      await writeFile(join(bundleDir, 'source-bundle.json'), JSON.stringify({
        identity: 'next', entrypoint: selected, runtimeDir: fixture.root, cliDir: fixture.root, env: {}, args: [],
        dependencyPublication: { markerPath, generationPath, identity: 'fixture-dependencies', writerActive: false },
      }));
      // The selected pointer refers to a completed producer capture. Activation
      // must use it directly, including when no compiler or watcher is running.
      await writeFile(join(sourceRoot, 'selected-daemon.json'), JSON.stringify({
        entrypoint: selected,
      }));
      await writeFile(join(fixture.root, 'package.json'), '{}');
      await recordStackRuntimeUpdate(runtimeStatePath, {
        processes: { daemonPid: initial.pid, daemonPids: [...initialPids.values()] },
        sourceRuntimeLaunch: { entrypoint: selected, cliDir: fixture.root, env: {} },
        sourceRuntimeIdentities: { daemon: { selected: 'next', loaded: 'next' } },
      });
      adoption = spawnTestProcess(process.execPath, [join(scriptsDir, 'run.mjs'),
        '--runtime=source', '--reuse-source-runtime', '--restart', '--no-dev-targets',
        '--no-server', '--server-url=' + serverUrl, '--no-ui', '--no-browser'], {
        cwd: dirname(rootDir), env: { ...env,
          HAPPIER_STACK_STORAGE_DIR: fixture.root, HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_REPO_DIR: fakeRepo, HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
          HAPPIER_STACK_ENV_FILE: fixture.path(stackName, 'env'),
          HAPPIER_DEV_TARGET_EXECUTION: '1',
          HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0', HAPPIER_STACK_TAILSCALE_SERVE: '0',
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [adoption.stdout, adoption.stderr]) stream.on('data', chunk => {
        const lines = String(chunk).split('\n').filter(line => !/token|secret|credential|DATABASE_URL|Bearer|jws/i.test(line));
        adoptionOutput += lines.join('\n');
      });
      children.push(adoption);
      // Wait for the real lifecycle's retained-daemon acknowledgement.
      const deadline = Date.now() + resolveServerReadyTimeoutMs();
      while (!/keeping existing daemon|daemon already running/i.test(adoptionOutput)) {
        assert.equal(adoption.exitCode, null, 'adoption runner must remain alive: ' + adoptionOutput);
        assert.ok(Date.now() < deadline, 'adoption must load its selected default daemon: ' + adoptionOutput);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // Named activation follows the default; use the process-fixture verification budget.
      const identityDeadline = Date.now() + named.length * Number(PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS);
      while (Date.now() < identityDeadline) {
        const lastIdentity = named.at(-1);
        const observed = await checkDaemonStatePingAware(fixture.path(`cli-identities/${lastIdentity}`), {
          stackName, serverUrl, env: applyStackDaemonLifecycleScopeEnv({
            env: { ...env, HAPPIER_STACK_CLI_IDENTITY: lastIdentity }, stackName, cliIdentity: lastIdentity,
          }),
        });
        if (observed.status === 'running' && observed.pid !== initialPids.get(lastIdentity)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } else {
      await executor.build();
      await executor.restart();
    }
    const participants = await readStackDaemonParticipants({ stackName, stackBaseDir: fixture.root,
      runtimeState: await readStackRuntimeStateFile(runtimeStatePath), cliHomeDir, serverUrl, env,
      defaultObservation: await checkDaemonStatePingAware(cliHomeDir, { stackName, serverUrl, env }), selected: 'next' });
    assert.deepEqual(participants.map(item => item.identity).sort(), ['default', ...named].sort());
    const expectedRestarts = adoption ? named : ['default', ...named];
    assert.deepEqual((await readFile(fixture.path('restarts.log'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })).trim().split('\n').filter(Boolean), expectedRestarts);
    for (const [name, previousPid] of initialPids) {
      const home = name === 'default' ? cliHomeDir : fixture.path(`cli-identities/${name}`);
      const state = JSON.parse(await readFile(join(home, 'servers', `stack_${stackName}__id_${name}`, 'daemon.state.json'), 'utf8'));
      if (adoption && name === 'default') assert.equal(state.pid, previousPid, 'retained default stays running');
      else assert.notEqual(state.pid, previousPid, `${name} must replace its old process`);
      assert.equal(state.startedWithRuntimeEntrypoint, selected, `${name} loads the prepared source`);
    }
    if (!adoption) await executor.restart();
    assert.deepEqual((await readFile(fixture.path('restarts.log'), 'utf8')).trim().split('\n'), expectedRestarts);
    return;
  }
  const result = await startLocalDaemonWithAuth(options).catch(error => ({ error }));
  assert.deepEqual(JSON.parse(await readFile(requestPath, 'utf8')), {
    path: '/restart',
    body: { successorServerUrls: { serverUrl, webappUrl: publicServerUrl } },
  });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(JSON.parse(await readFile(reloadPath, 'utf8')).status, 'ready');
  assert.equal(JSON.parse(await readFile(reloadPath, 'utf8')).code, undefined);
  assert.doesNotThrow(() => process.kill(runner.pid, 0));
  let state = await readStackRuntimeStateFile(runtimeStatePath);
  assert.deepEqual(state.sourceRuntimeIdentities.daemon, identity === 'default'
    ? { selected: 'next', loaded: 'next' } : { selected: 'old', loaded: 'old' });
  assert.deepEqual(state.sourceRuntimeIdentities.server, { selected: 'server', loaded: 'server' });
  if (identity !== 'default') return;
  await recordSourceReloadRefusal({ stackBaseDir: fixture.root, error: refusal, env });
  await assert.rejects(startLocalDaemonWithAuth({ ...options,
    sourceRuntimeLaunchUpdate: { launch: { entrypoint: incumbent, cliDir: fixture.root }, identity: 'unloaded' },
  }), /selected source daemon.*not loaded/);
  state = await readStackRuntimeStateFile(runtimeStatePath);
  assert.equal(state.sourceRuntimeIdentities.daemon.loaded, null);
  assert.equal(JSON.parse(await readFile(reloadPath, 'utf8')).status, 'failed');
});
}

test('source restart exposes an HTTP 400 as a typed control failure without replacing the daemon', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-reload-control-failure-', registerCleanup: false });
  const cliHomeDir = fixture.path('cli');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'fixture-credential\n');
  const stackName = 'source-control-failure-reload';
  const statePath = join(cliHomeDir, 'servers', `stack_${stackName}__id_default`, 'daemon.state.json');
  const runtimeStatePath = fixture.path('stack.runtime.json');
  const requestsPath = fixture.path('requests.jsonl');
  const incumbent = fixture.path('incumbent.mjs');
  const selected = fixture.path('selected.mjs');
  const children = [];
  t.after(async () => {
    if (existsSync(statePath)) {
      const { pid } = JSON.parse(await readFile(statePath, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await fixture.cleanup();
  });
  const serverUrl = 'http://127.0.0.1:4301';
  const publicServerUrl = 'http://source-control-failure-reload.localhost:4301';
  const staleServerUrl = 'http://127.0.0.1:59671';
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }), HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: fixture.path('env'), HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_PROCESS_KIND: 'daemon', HAPPIER_SERVER_URL: staleServerUrl,
    HAPPIER_WEBAPP_URL: 'http://stale.localhost:59671',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0', HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0' };
  const script = `
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const statePath = ${JSON.stringify(statePath)};
if (process.argv[2] !== 'daemon' || process.argv[3] !== 'start-sync') process.exit(1);
const server = createServer((req, res) => {
  if (req.headers['x-happier-daemon-token'] !== 'fixture-token') { res.writeHead(401); res.end(); return; }
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ path: req.url, body: JSON.parse(raw) }) + '\\n');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ping') { res.end('{"ok":true}'); return; }
    if (req.url === '/restart') { res.writeHead(400); res.end('{"error":"unknown field successorServerUrls"}'); return; }
    res.writeHead(404); res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ pid: process.pid, httpPort: server.address().port, controlToken: 'fixture-token' }));
  process.send?.('ready'); process.disconnect?.();
});
`;
  await writeFile(incumbent, script);
  await writeFile(selected, script);
  await recordStackRuntimeUpdate(runtimeStatePath, { stackName, processes: {},
    sourceRuntimeLaunch: { entrypoint: incumbent, cliDir: fixture.root },
    sourceRuntimeIdentities: { server: { selected: 'server', loaded: 'server' }, daemon: { selected: 'old', loaded: 'old' } } });
  const runner = spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  children.push(runner);
  const initial = spawnTestProcess(process.execPath, [incumbent, 'daemon', 'start-sync'], {
    env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(initial);
  await once(initial, 'message');

  await assert.rejects(
    startLocalDaemonWithAuth({ cliBin: incumbent, cliEntrypoint: selected, cliHomeDir,
      internalServerUrl: serverUrl, publicServerUrl, stackName, runtimeStatePath,
      env: { ...env, HAPPIER_WEBAPP_URL: publicServerUrl },
      forceRestart: true, preserveSessionsOnRestart: true,
      sourceRuntimeLaunchUpdate: { launch: { entrypoint: selected, cliDir: fixture.root }, identity: 'next' } }),
    (error) => error instanceof DaemonControlPostError && error.status === 400,
  );
  assert.doesNotThrow(() => process.kill(runner.pid, 0));
  assert.deepEqual((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon,
    { selected: 'next', loaded: null });
  const requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests, [{
    path: '/restart',
    body: { successorServerUrls: { serverUrl, webappUrl: publicServerUrl } },
  }]);
});

for (const readinessCase of ['ready', 'missing-registration', 'registration-unavailable', 'agent-drop', 'authenticated-read-failure']) {
test(`source launch readiness ${readinessCase} retires unpublished generations and verifies its successor`, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-source-daemon-supersede-'));
  const cliHomeDir = join(tmp, 'cli');
  const stackName = 'source-supersede';
  const internalServerUrl = 'http://127.0.0.1:4301';
  let replacement = false;
  let authenticatedReads = 0;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === `${internalServerUrl}/v2/sessions`) {
      authenticatedReads += 1;
      assert.ok(Boolean(options?.headers?.Authorization), 'read uses existing stack credentials');
      return new Response('{}', { status: replacement && readinessCase === 'authenticated-read-failure' ? 500 : 200 });
    }
    return originalFetch(url, options);
  });
  const pids = [];
  const pidPath = join(tmp, 'spawned-pid');
  t.after(async () => {
    for (const pid of pids) killDetachedProcessGroup(pid, 'SIGKILL');
    if (existsSync(pidPath)) killDetachedProcessGroup(Number(await readFile(pidPath, 'utf8')), 'SIGKILL');
    await rm(tmp, { recursive: true, force: true });
  });
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'fixture-credential\n');
  for (let generation = 0; generation < 2; generation++) {
    const child = spawnDetachedTestProcess(process.execPath,
      ['-e', "process.send('ready'); process.disconnect(); setInterval(() => {}, 1000);", 'daemon', 'start-sync'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, HAPPIER_STACK_STACK: stackName, HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_STACK_PROCESS_KIND: 'daemon', HAPPIER_SERVER_URL: internalServerUrl },
      });
    pids.push(child.pid);
    await once(child, 'message');
  }
  const entrypoint = join(tmp, 'source-main.mjs');
  const successorEntrypoint = join(tmp, 'source-successor.mjs');
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  for (const [launchPath, identity] of [[entrypoint, 'source-a'], [successorEntrypoint, 'source-b']]) {
  await writeFile(launchPath, `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};
import { observePidLiveness } from ${JSON.stringify(join(scriptsDir, 'utils/proc/pids.mjs'))};
const [command, action] = process.argv.slice(2);
if (command === 'daemon' && action === 'stop') {
  const retained = JSON.parse(readFileSync(${JSON.stringify(runtimeStatePath)}, 'utf8'));
  if (retained.sourceRuntimeLaunch?.entrypoint && retained.sourceRuntimeLaunch.entrypoint !== ${JSON.stringify(launchPath)}) process.exit(78);
}
if (command === 'daemon' && action === 'start') {
  const retained = JSON.parse(readFileSync(${JSON.stringify(runtimeStatePath)}, 'utf8'));
  if (retained.sourceRuntimeLaunch.entrypoint !== ${JSON.stringify(launchPath)}
    || retained.sourceRuntimeIdentities.daemon.selected !== ${JSON.stringify(identity)}
    || retained.sourceRuntimeIdentities.daemon.loaded !== null) process.exit(79);
  for (const pid of ${JSON.stringify(pids)}) {
    if (observePidLiveness(pid).status === 'alive') process.exit(77);
  }
  const child = spawnDaemonLikeProcess({ cliHomeDir: process.env.HAPPIER_HOME_DIR,
    statePaths: [${JSON.stringify(join(cliHomeDir, 'servers', `stack_${stackName}__id_default`, 'daemon.state.json'))}],
    internalServerUrl: process.env.HAPPIER_SERVER_URL,
    env: { HAPPIER_TEST_RELOAD_CATALOG: ${JSON.stringify(JSON.stringify({ kind: 'available', plugins: [{ contributionIntrospection: { contributions: Array.from({ length: identity === 'source-b' && readinessCase === 'agent-drop' ? 1 : 2 }, (_, i) => ({ contribution: { family: 'agents', localId: String(i) }, registration: { state: 'bound' } })) } }] }))} } });
  mkdirSync(${JSON.stringify(join(cliHomeDir, 'logs'))}, { recursive: true });
  ${identity === 'source-b' && readinessCase === 'ready' ? `
  writeFileSync(${JSON.stringify(join(cliHomeDir, 'logs'))} + '/' + child.pid + '-daemon.log', 'Starting');
  await new Promise(resolve => setTimeout(resolve, 300));
  ` : ''}
  writeFileSync(${JSON.stringify(join(cliHomeDir, 'logs'))} + '/' + child.pid + '-daemon.log', ${JSON.stringify(identity === 'source-b' && readinessCase === 'missing-registration' ? 'Starting' : identity === 'source-b' && readinessCase === 'registration-unavailable' ? 'Machine registered\nMachine registration unavailable' : 'Machine registered')});
  writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
}
process.exit(0);
`);
  }
  await writeFile(runtimeStatePath, JSON.stringify({ stackName, processes: {} }));
  const options = { cliBin: entrypoint, cliEntrypoint: entrypoint, cliHomeDir, internalServerUrl,
    publicServerUrl: internalServerUrl, stackName, forceRestart: true, isTui: false, isShuttingDown: () => false,
    runtimeStatePath, sourceRuntimeLaunchUpdate: { launch: { entrypoint, cliDir: tmp }, identity: 'source-a' },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0', HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1500',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0' } };
  const reloadPath = join(tmp, 'source-runtime/reload.json');
  await recordSourceReloadRefusal({ stackBaseDir: tmp,
    error: Object.assign(new Error('source dependency refresh required'), {
      component: 'daemon', code: 'SOURCE_RUNTIME_RELOAD_REQUIRED',
    }), env: options.env });
  assert.equal((await startLocalDaemonWithAuth(options)).started, true);
  assert.equal(JSON.parse(await readFile(reloadPath, 'utf8')).status, 'ready');
  const first = Number(await readFile(pidPath, 'utf8'));
  assert.equal(authenticatedReads, 1, 'one authenticated read per source readiness wait');
  replacement = true;
  pids.push(first);
  assert.deepEqual((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon,
    { selected: 'source-a', loaded: 'source-a' });
  for (const pid of pids.slice(0, 2)) assert.throws(() => process.kill(pid, 0));
  await recordSourceReloadRefusal({ stackBaseDir: tmp,
    error: Object.assign(new Error('server source remains unavailable'), { component: 'server' }), env: options.env });
  const serverRefusal = JSON.parse(await readFile(reloadPath, 'utf8'));
  if (readinessCase !== 'ready') {
    await assert.rejects(startLocalDaemonWithAuth({ ...options,
      sourceRuntimeLaunchUpdate: { launch: { entrypoint: successorEntrypoint, cliDir: tmp }, identity: 'source-b' },
    }), readinessCase === 'authenticated-read-failure' ? /NOT_READY.*\/v2\/sessions.*500/ : /NOT_READY.*(?:Machine|Agent)/);
    if (readinessCase === 'authenticated-read-failure') assert.equal(authenticatedReads, 2,
      'failed authentication is observed once, rather than polled until the readiness deadline');
    pids.push(Number(await readFile(pidPath, 'utf8')));
    assert.equal((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon.loaded, null);
    return;
  }
  assert.equal((await startLocalDaemonWithAuth({ ...options,
    sourceRuntimeLaunchUpdate: { launch: { entrypoint: successorEntrypoint, cliDir: tmp }, identity: 'source-b' },
  })).started, true);
  assert.equal(authenticatedReads, 2, 'the successor has its own single authenticated readiness read');
  const second = Number(await readFile(pidPath, 'utf8'));
  pids.push(second);
  assert.notEqual(second, first);
  assert.throws(() => process.kill(first, 0), 'replacement must retire the previously ready generation');
  assert.doesNotThrow(() => process.kill(second, 0));
  assert.deepEqual((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon,
    { selected: 'source-b', loaded: 'source-b' });
  assert.deepEqual(JSON.parse(await readFile(reloadPath, 'utf8')), serverRefusal);
});

}

function buildDelayedDaemonStartCliScript({
  cliHomeDir,
  startDelayMs,
  startExitCode = 0,
  childPidPath = '',
}) {
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
  const lockPath = `${statePath}.lock`;
  return `
import { writeFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  const child = spawnDaemonLikeProcess({
    cliHomeDir: home,
    statePaths: [${JSON.stringify(statePath)}],
    internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
    publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
    startDelayMs: ${JSON.stringify(startDelayMs)},
  });
  writeFileSync(${JSON.stringify(lockPath)}, String(child.pid), 'utf-8');
  ${childPidPath ? `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), 'utf-8');` : ''}
  process.exit(${JSON.stringify(startExitCode)});
}

process.exit(0);
`.trimStart();
}

function buildBudgetBoundDaemonStartCliScript({
  cliHomeDir,
  startDelayMs,
  childPidPath,
  outcomePath,
}) {
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
  return `
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);
if (sub !== 'start') process.exit(0);

const child = spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  statePaths: [${JSON.stringify(statePath)}],
  internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
  publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
  startDelayMs: ${JSON.stringify(startDelayMs)},
});
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), 'utf-8');

const waitMs = Number(process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS || '0');
if (waitMs < ${JSON.stringify(startDelayMs)}) {
  await delay(Math.max(waitMs, 1));
  writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify({ outcome: 'failed', waitMs }), 'utf-8');
  process.exit(1);
}

await delay(${JSON.stringify(startDelayMs)});
writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify({ outcome: 'started', waitMs }), 'utf-8');
`.trimStart();
}

function buildSynchronousDaemonStartCliScript({ cliHomeDir, startDelayMs }) {
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
  return `
import { startDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  await startDaemonLikeProcess({
    statePaths: [${JSON.stringify(statePath)}],
    startDelayMs: ${JSON.stringify(startDelayMs)},
  });
} else {
  process.exit(0);
}
`.trimStart();
}

test('stack daemon start verification default matches the daemon restart wait budget', () => {
  assert.equal(resolveStackDaemonStartVerifyTimeoutMs({}), 120_000);
  assert.equal(resolveStackDaemonStartVerifyTimeoutMs({ HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1234' }), 1234);
});

test('daemon verification extends a checkpoint only for a live startup', () => {
  assert.equal(shouldContinueDaemonStartVerification({
    state: { status: 'starting', pid: 123 },
  }), true);
  assert.equal(shouldContinueDaemonStartVerification({
    state: { status: 'stopped' },
    startWrapperAlive: true,
  }), true);
  assert.equal(shouldContinueDaemonStartVerification({
    state: { status: 'stopped' },
  }), false);
});

test('attended startup removes terminal lock and credential deadlines without changing unattended budgets', () => {
  assert.equal(resolveAttendedStartupTimeoutMs({ isTui: true, timeoutMs: 1234 }), Infinity);
  assert.equal(resolveAttendedStartupTimeoutMs({ isTui: false, timeoutMs: 1234 }), 1234);
});

test('matchDaemonEnvLine identifies which daemon env binding differs', () => {
  const line = [
    'node',
    'HAPPIER_HOME_DIR=/tmp/happier-stack/cli',
    'HAPPIER_SERVER_URL=http://127.0.0.1:52753',
    'HAPPIER_WEBAPP_URL=http://stale.example.com:52753',
  ].join(' ');

  assert.deepEqual(matchDaemonEnvLine({
    line,
    cliHomeDir: '/tmp/happier-stack/cli',
    internalServerUrl: 'http://127.0.0.1:52753',
    publicServerUrl: 'http://happier-stack.localhost:52753',
  }), {
    matches: false,
    reason: 'webapp',
    key: 'HAPPIER_WEBAPP_URL',
    expected: 'http://happier-stack.localhost:52753',
  });
});

test('matchDaemonEnvLine treats canonical loopback server URL spellings as the same identity', () => {
  const line = [
    'node',
    'HAPPIER_HOME_DIR=/tmp/happier-stack/cli',
    'HAPPIER_SERVER_URL=http://qa-stack.localhost:52753/path?ignored=true',
    'HAPPIER_WEBAPP_URL=http://127.0.0.1:52753/',
  ].join(' ');

  assert.deepEqual(matchDaemonEnvLine({
    line,
    cliHomeDir: '/tmp/happier-stack/cli',
    internalServerUrl: 'http://127.0.0.1:52753',
    publicServerUrl: 'http://localhost:52753',
  }), { matches: true });
});

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env: createFixtureStackEnv(cwd, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr }));
  });
}

function runNodeWithTimeout(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawnDetachedTestProcess(process.execPath, args, {
      cwd,
      env: createFixtureStackEnv(cwd, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // ignore
      }
      finish({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', fail);
    proc.on('exit', (code, signal) =>
      finish({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr, timedOut: false })
    );
  });
}

function createFixtureStackEnv(repoDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_TUI: '0',
  };
}

async function writeStubHappyCli({ cliDir }) {
  const distScript = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const logsDir = join(home, 'logs');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, \`\${Date.now()}-pid-\${process.pid}-daemon.log\`);
  writeFileSync(
    logPath,
    '[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1 {"message":"Request failed with status code 401","status":401}\\n',
    'utf-8'
  );
  // Simulate false-positive daemon start command: exits 0 but daemon is not actually running.
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    // If daemon.mjs accidentally invokes bin/happier.mjs, fail loudly.
    binHappierScript: 'process.exit(42);\n',
  });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  const dependencyRefresh = await inspectDependencyRefresh({ installDir: cliDir, componentDir: cliDir });
  await mkdir(dirname(dependencyRefresh.markerPath), { recursive: true });
  await writeFile(
    dependencyRefresh.markerPath,
    `${JSON.stringify({ version: 3, installDir: cliDir, inputs: dependencyRefresh.inputSnapshot, superseded: false })}\n`,
    'utf-8',
  );
  return join(cliBinDir, 'happier.mjs');
}

function buildProfileCaptureDaemonCliScript({ cliHomeDir, capturePath, serverSetDelayMs = 0 }) {
  const activeServerId = 'stack_dev__id_default';
  const statePath = join(cliHomeDir, 'servers', activeServerId, 'daemon.state.json');
  return `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] === 'server' && args[1] === 'set' && ${JSON.stringify(serverSetDelayMs)} > 0) {
  const { setTimeout: delay } = await import('node:timers/promises');
  await delay(${JSON.stringify(serverSetDelayMs)});
}

${buildStubHappierServerSetSource()}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop' || sub === 'status') process.exit(0);
if (sub !== 'start') process.exit(0);

const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf-8'));
const activeServerId = String(settings.activeServerId || '');
writeFileSync(
  ${JSON.stringify(capturePath)},
  JSON.stringify({ activeServerId, profile: settings.servers?.[activeServerId] ?? null }) + '\\n',
  'utf-8',
);
spawnDaemonLikeProcess({
  cliHomeDir: home,
  internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
  publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
  statePaths: [${JSON.stringify(statePath)}],
});
process.exit(0);
`.trimStart();
}

async function overwriteStubCliDist(cliDir, source) {
  // Custom daemon behavior still crosses the same profile-setting OS boundary.
  const profileSource = `{\nconst args = process.argv.slice(2);\n${buildStubHappierServerSetSource()}\n}\n`;
  await writeFile(join(cliDir, 'dist', 'index.mjs'), profileSource + source, 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
}

function createTestJwt({ sub, jti }) {
    const headerJson = JSON.stringify({ alg: 'none', typ: 'JWT' });
    const payloadJson = JSON.stringify({ sub, ...(jti ? { jti } : {}) });
    const toB64Url = (value) =>
        Buffer.from(value, 'utf8')
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    return `${toB64Url(headerJson)}.${toB64Url(payloadJson)}.`;
}

async function withAuthServer({ goodToken }, fn) {
    const server = http.createServer((req, res) => {
        if (!req.url || !req.method) {
            res.statusCode = 400;
            res.end();
            return;
        }
        if (req.method !== 'GET' || req.url !== '/v1/account/profile') {
            res.statusCode = 404;
            res.end();
            return;
        }
        const auth = String(req.headers.authorization ?? '').trim();
        if (auth === `Bearer ${goodToken}`) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert.ok(port, 'auth test server should expose a port');
    const serverUrl = `http://127.0.0.1:${port}`;
    try {
        return await fn({ serverUrl });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function writeAccessKeyFile(path, token) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        JSON.stringify(
            {
                encryption: { publicKey: 'AA==', machineKey: 'AA==' },
                token,
            },
            null,
            2,
        ),
        'utf-8',
    );
}

for (const prepared of [false, true]) {
test('startLocalDaemonWithAuth treats daemon start exit=0 as failure when daemon never becomes running' + (prepared ? ' after PREPARED in TUI mode' : ''), async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-verify-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_TUI: prepared ? '1' : '0',
      HAPPIER_STACK_PREPARED_SOURCE_RELOAD: prepared ? '1' : '0',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    };

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliCommand: process.execPath,
        cliCommandArgs: [join(cliDir, 'dist', 'index.mjs')],
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
      }),
      /Failed to auto re-seed daemon credentials|Failed to start daemon|NOT_READY/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

}

test('startLocalDaemonWithAuth fails promptly after a non-zero start wrapper exits without daemon state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-nonzero-no-state-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const runnerPath = join(tmp, 'runner.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 5,
      machineId: 'test-machine',
      activeServerId: 'stack_dev__id_default',
      servers: {
        stack_dev__id_default: {
          id: 'stack_dev__id_default',
          serverUrl: 'http://localhost:4301',
          localServerUrl: 'http://127.0.0.1:4301',
          webappUrl: 'http://localhost:4301',
        },
      },
    }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      `
const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const [scope, action] = args;
if (scope !== 'daemon') process.exit(0);
if (action === 'stop' || action === 'status') process.exit(0);
if (action === 'start') process.exit(1);
process.exit(0);
      `.trimStart(),
      'utf-8',
    );
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const startedAt = Date.now();
try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliCommand: process.execPath,
    cliCommandArgs: [${JSON.stringify(cliCommandScript)}],
    cliHomeDir: ${JSON.stringify(cliHomeDir)},
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
    isShuttingDown: () => false,
    forceRestart: true,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '30000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
  console.error('unexpected daemon start success');
  process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    message: error instanceof Error ? error.message : String(error),
  }));
}
      `.trimStart(),
      'utf-8',
    );

    const result = await runNodeWithTimeout([runnerPath], {
      cwd: tmp,
      env: process.env,
      timeoutMs: Number(PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS),
    });

    assert.equal(
      result.timedOut,
      false,
      `a failed wrapper without daemon state must not wait for the 30s verification deadline\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const observation = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.match(observation.message, /Failed to start daemon/);
    assert.ok(
      observation.elapsedMs < Number(PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS),
      `daemon start failure took ${observation.elapsedMs}ms instead of returning before its 30s verification deadline`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth reconciles a stale active stack profile before spawning the daemon', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-profile-reconcile-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const cliBin = join(tmp, 'bin', 'happier');
    const cliCommandScript = join(tmp, 'profile-capture-daemon.mjs');
    const cliNodeEntrypoint = join(tmp, 'inspection-only-entrypoint.mjs');
    const capturePath = join(tmp, 'profile-at-daemon-start.json');
    const activeServerId = 'stack_dev__id_default';
    const internalServerUrl = 'http://127.0.0.1:4311';
    const publicServerUrl = 'http://localhost:4311';
    const credentialContents = 'credential-must-remain-unchanged\\n';

    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      buildProfileCaptureDaemonCliScript({ cliHomeDir, capturePath }),
      'utf-8',
    );
    // Runtime snapshots expose their dist for closure inspection alongside an admitted
    // launcher. Executing that inspection path must not replace the launch command.
    await writeFile(cliNodeEntrypoint, 'process.exit(88);\n', 'utf-8');
    await writeFile(
      join(cliHomeDir, 'settings.json'),
      JSON.stringify({
        schemaVersion: 6,
        activeServerId,
        servers: {
          [activeServerId]: {
            id: activeServerId,
            name: 'Controlled stack profile',
            serverUrl: 'http://127.0.0.1:3012',
            localServerUrl: 'http://127.0.0.1:3012',
            webappUrl: 'http://localhost:3012',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
            preservedProfileField: 'keep-me',
          },
        },
      }, null, 2) + '\n',
      'utf-8',
    );

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '2000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    };
    const credentialPaths = resolveStackCredentialPaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: { ...env, HAPPIER_ACTIVE_SERVER_ID: activeServerId },
    });
    await mkdir(dirname(credentialPaths.serverScopedPath), { recursive: true });
    await writeFile(credentialPaths.serverScopedPath, credentialContents, 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliNodeEntrypoint,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonState = JSON.parse(
      await readFile(join(cliHomeDir, 'servers', activeServerId, 'daemon.state.json'), 'utf-8'),
    );
    daemonPid = Number(daemonState?.pid);

    const profileAtDaemonStart = JSON.parse(await readFile(capturePath, 'utf-8'));
    assert.equal(profileAtDaemonStart.activeServerId, activeServerId);
    assert.equal(profileAtDaemonStart.profile?.serverUrl, publicServerUrl);
    assert.equal(profileAtDaemonStart.profile?.localServerUrl, internalServerUrl);
    assert.equal(profileAtDaemonStart.profile?.webappUrl, publicServerUrl);
    assert.equal(profileAtDaemonStart.profile?.preservedProfileField, 'keep-me');

    const persistedSettings = JSON.parse(await readFile(join(cliHomeDir, 'settings.json'), 'utf-8'));
    assert.equal(persistedSettings.activeServerId, activeServerId);
    assert.equal(persistedSettings.servers[activeServerId].serverUrl, publicServerUrl);
    assert.equal(persistedSettings.servers[activeServerId].localServerUrl, internalServerUrl);
    assert.equal(persistedSettings.servers[activeServerId].webappUrl, publicServerUrl);
    assert.equal(persistedSettings.servers[activeServerId].preservedProfileField, 'keep-me');
    assert.equal(await readFile(credentialPaths.serverScopedPath, 'utf-8'), credentialContents);
  } finally {
    if (Number.isFinite(daemonPid) && daemonPid > 1) {
      killDetachedProcessGroup(daemonPid, 'SIGKILL');
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth bounds profile reconciliation by the daemon startup readiness budget', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-profile-timeout-'));
  try {
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const cliBin = join(tmp, 'bin', 'happier');
    const cliCommandScript = join(tmp, 'profile-delay-daemon.mjs');
    const activeServerId = 'stack_dev__id_default';
    const internalServerUrl = 'http://127.0.0.1:4312';
    const publicServerUrl = 'http://localhost:4312';

    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      buildProfileCaptureDaemonCliScript({ cliHomeDir, capturePath: join(tmp, 'unused.json'), serverSetDelayMs: 200 }),
      'utf-8',
    );
    await writeFile(
      join(cliHomeDir, 'settings.json'),
      JSON.stringify({
        schemaVersion: 6,
        activeServerId,
        servers: {
          [activeServerId]: {
            id: activeServerId,
            name: 'Delayed profile',
            serverUrl: 'http://127.0.0.1:3012',
            localServerUrl: 'http://127.0.0.1:3012',
            webappUrl: 'http://localhost:3012',
          },
        },
      }) + '\n',
      'utf-8',
    );

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: activeServerId,
    };
    const credentialPaths = resolveStackCredentialPaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env,
    });
    await mkdir(dirname(credentialPaths.serverScopedPath), { recursive: true });
    await writeFile(credentialPaths.serverScopedPath, 'credential-must-remain-unchanged\n', 'utf-8');

    const startedAt = Date.now();
    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliCommand: process.execPath,
        cliCommandArgs: [cliCommandScript],
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      (error) => {
        assert.equal(error?.code, 'ETIMEDOUT');
        assert.equal(error?.timeoutMs, 25);
        assert.match(error?.message ?? '', /server profile reconciliation/i);
        assert.match(error?.message ?? '', /25ms/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1_000, 'profile preflight must honor the startup budget');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not present a daemon log from before the failed start attempt', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-current-log-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const originalConsoleError = console.error;
  const errorOutput = [];

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(join(cliHomeDir, 'logs'), { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'logs', '1-pid-1-daemon.log'), 'historical daemon failure\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      `
const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const [scope, action] = args;
if (scope !== 'daemon') process.exit(0);
if (action === 'stop') process.exit(0);
if (action === 'status') process.exit(1);
if (action === 'start') process.exit(0);
process.exit(0);
      `.trimStart(),
      'utf-8',
    );

    console.error = (...args) => {
      errorOutput.push(args.map((arg) => String(arg)).join(' '));
    };

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliCommand: process.execPath,
        cliCommandArgs: [cliCommandScript],
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...createFixtureStackEnv(tmp),
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /Failed to start daemon/,
    );

    const diagnostics = errorOutput.join('\n');
    assert.doesNotMatch(diagnostics, /historical daemon failure/);
    assert.match(diagnostics, /no daemon log found/);
  } finally {
    console.error = originalConsoleError;
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth cancels and joins shutdown daemon start wrappers before retry', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-timeout-cancel-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const wrapperPidPath = join(tmp, 'wrapper.pid');
  let wrapperPid = null;

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      `
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const [scope, action] = args;
if (scope !== 'daemon') process.exit(0);
if (action === 'stop') process.exit(0);
if (action === 'status') process.exit(1);
if (action !== 'start') process.exit(0);

writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid), 'utf-8');
setInterval(() => {}, 1_000);
      `.trimStart(),
      'utf-8',
    );

    const startArgs = {
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => existsSync(wrapperPidPath),
      forceRestart: true,
      env: {
        ...createFixtureStackEnv(tmp),
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '150',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    };

    await assert.rejects(
      startLocalDaemonWithAuth(startArgs),
      /Failed to start daemon/,
    );

    wrapperPid = Number(await readFile(wrapperPidPath, 'utf-8'));
    assert.ok(Number.isFinite(wrapperPid) && wrapperPid > 1);
    assert.throws(
      () => process.kill(wrapperPid, 0),
      `cancelled daemon start wrapper ${wrapperPid} must exit before another reconciliation can start`,
    );

    await writeFile(wrapperPidPath, '', 'utf-8');
    const shutdownStartedAt = Date.now();
    await assert.rejects(
      startLocalDaemonWithAuth({
        ...startArgs,
        isShuttingDown: () => true,
        env: {
          ...startArgs.env,
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '30000',
        },
      }),
      /Failed to start daemon/,
    );
    assert.ok(Date.now() - shutdownStartedAt < 5_000, 'shutdown must cancel the active start attempt without waiting for its health deadline');
  } finally {
    if (Number.isFinite(wrapperPid) && wrapperPid > 1) {
      try {
        killDetachedProcessGroup(wrapperPid, 'SIGKILL');
      } catch {
        // already stopped by the owner under test
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth fails fast when stack-scoped auth is stale and only a different-account fallback is valid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-auth-stale-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev__id_default',
    };

    const staleToken = createTestJwt({ sub: 'account-a', jti: 'stale' });
    const validOtherAccountToken = createTestJwt({ sub: 'account-b', jti: 'valid' });

    await withAuthServer({ goodToken: validOtherAccountToken }, async ({ serverUrl }) => {
      const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      await writeAccessKeyFile(resolved.serverScopedPath, staleToken);
      await writeAccessKeyFile(resolved.urlHashServerScopedPath, validOtherAccountToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
          cliEntrypoint: join(cliDir, 'dist', 'index.mjs'),
          cliHomeDir,
          internalServerUrl: serverUrl,
          publicServerUrl: serverUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
        }),
        /Failed to auto re-seed daemon credentials|credentials were rejected by the server|auth login/i,
      );

      await assert.rejects(stat(join(cliHomeDir, 'logs')), { code: 'ENOENT' });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not backfill legacy access.key from main when the stack already has a server-scoped credential', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-no-legacy-backfill-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const storageDir = join(tmp, 'storage');
    const stackName = 'dev';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const mainCliHomeDir = join(storageDir, 'main', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(mainCliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '1',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
    };

    const currentToken = createTestJwt({ sub: 'current-account', jti: 'current' });
    const mainToken = createTestJwt({ sub: 'main-account', jti: 'main' });

    await withAuthServer({ goodToken: currentToken }, async ({ serverUrl }) => {
      const targetPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      const mainPaths = resolveStackCredentialPaths({
        cliHomeDir: mainCliHomeDir,
        serverUrl,
        env: { ...env, HAPPIER_STACK_STACK: 'main', HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
      });

      await writeAccessKeyFile(targetPaths.serverScopedPath, currentToken);
      await writeAccessKeyFile(mainPaths.serverScopedPath, mainToken);
      await writeAccessKeyFile(join(mainCliHomeDir, 'access.key'), mainToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
          cliEntrypoint: join(cliDir, 'dist', 'index.mjs'),
          cliHomeDir,
          internalServerUrl: serverUrl,
          publicServerUrl: serverUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName,
        }),
        /Failed to auto re-seed daemon credentials|Failed to start daemon|credentials were rejected by the server/i,
      );

      await assert.rejects(stat(join(cliHomeDir, 'access.key')), { code: 'ENOENT' });
      const activeCredential = JSON.parse(await readFile(targetPaths.serverScopedPath, 'utf-8'));
      assert.equal(activeCredential.token, currentToken);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth seeds the current server credential when the stack only has an unrelated server credential', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-unrelated-credential-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const storageDir = join(tmp, 'storage');
    const stackName = 'dev';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const mainCliHomeDir = join(storageDir, 'main', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(mainCliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '1',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
    };

    const currentToken = createTestJwt({ sub: 'current-account', jti: 'current' });
    const unrelatedToken = createTestJwt({ sub: 'other-account', jti: 'unrelated' });

    await withAuthServer({ goodToken: currentToken }, async ({ serverUrl }) => {
      const targetPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      const mainPaths = resolveStackCredentialPaths({
        cliHomeDir: mainCliHomeDir,
        serverUrl,
        env: {
          ...env,
          HAPPIER_STACK_STACK: 'main',
          HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default',
        },
      });
      const unrelatedPath = join(cliHomeDir, 'servers', 'qa-deep-local', 'access.key');

      await writeAccessKeyFile(unrelatedPath, unrelatedToken);
      await writeAccessKeyFile(mainPaths.serverScopedPath, currentToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
          cliEntrypoint: join(cliDir, 'dist', 'index.mjs'),
          cliHomeDir,
          internalServerUrl: serverUrl,
          publicServerUrl: serverUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName,
        }),
        /Failed to auto re-seed daemon credentials|Failed to start daemon|credentials were rejected by the server/i,
      );

      const seededLegacyCredential = JSON.parse(await readFile(targetPaths.legacyPath, 'utf-8'));
      const seededServerCredential = JSON.parse(await readFile(targetPaths.serverScopedPath, 'utf-8'));
      const unrelatedCredential = JSON.parse(await readFile(unrelatedPath, 'utf-8'));
      assert.equal(seededLegacyCredential.token, currentToken);
      assert.equal(seededServerCredential.token, currentToken);
      assert.equal(unrelatedCredential.token, unrelatedToken);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth streams daemon start output in TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-stream-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    // Overwrite the stub to print a deterministic line on daemon start.
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
	const args = process.argv.slice(2);
	if (args[0] === 'daemon' && args[1] === 'start') {
	  console.log('stub daemon start');
	  process.exit(1);
	}
	process.exit(0);
	`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const env = {
  ...process.env,
  HAPPIER_STACK_TUI: '1',
  HAPPIER_STACK_AUTO_AUTH_SEED: '0',
  HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
  HAPPIER_STACK_CLI_BUILD: '1',
  HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '3000',
  HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
  HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
};

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliCommand: process.execPath,
    cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
    cliHomeDir: ${JSON.stringify(cliHomeDir)},
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
    isShuttingDown: () => false,
    forceRestart: true,
    env,
    stackName: 'dev',
  });
} catch {
  // Expected: stub exits non-zero and no daemon state is written.
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.match(res.stdout + res.stderr, /\[daemon\] stub daemon start/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when the daemon start wrapper exits by signal', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-signaled-start-'));

  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  process.kill(process.pid, 'SIGTERM');
  setInterval(() => {}, 1000);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: process.execPath,
  cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: ${JSON.stringify(PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS)},
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_TIMEOUT_MS: '1000',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /daemon start failed before the relay came up; keeping TUI running/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when the daemon log reports invalid auth', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-invalid-auth-'));

  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: process.execPath,
  cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1000',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_TIMEOUT_MS: '1000',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /daemon start failed before the relay came up; keeping TUI running/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when daemon start reports an installed background service conflict', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-service-conflict-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: process.execPath,
  cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: ${JSON.stringify(PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS)},
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /\[daemon\] .*keeping TUI running\./);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves installed-service ownership guidance outside TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-guidance-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  const delayedOutput = spawn(process.execPath, ['-e', "setTimeout(() => { console.error('A background service is already installed for this relay.'); console.error('Use ' + String.fromCharCode(96) + 'happier service start' + String.fromCharCode(96) + ' to start the installed background service instead of starting a new relay runtime.'); console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.'); }, 3000);"], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  delayedOutput.unref();
  process.exit(1);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliHomeDir: ${JSON.stringify(cliHomeDir)},
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
    isShuttingDown: () => false,
    forceRestart: true,
    env: {
      ...process.env,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: ${JSON.stringify(String(DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS))},
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
    stackName: 'dev',
  });
  process.exit(0);
} catch (error) {
  console.error('CAUGHT_ERROR=' + JSON.stringify(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNodeWithTimeout([runnerPath], { cwd: tmp, env: process.env, timeoutMs: 15_000 });
    assert.equal(res.timedOut, false, `${res.stdout}${res.stderr}`);
    assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
    assert.match(
      res.stderr,
      /CAUGHT_ERROR=.*Use `happier service start` to start the installed background service instead of starting a new relay runtime\./
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth recovers from installed-service conflict by starting the installed service owner', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-recover-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const launchAgentPath = join(tmp, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
    await mkdir(dirname(launchAgentPath), { recursive: true });
    await writeFile(launchAgentPath, '<plist version="1.0"></plist>\n', 'utf-8');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — ' + ${JSON.stringify(launchAgentPath)});
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}
if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const launchctlRunnerPath = join(tmp, 'launchctl-runner.mjs');
    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    await writeFile(
      launchctlRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
${JSON.stringify(process.execPath)} ${JSON.stringify(launchctlRunnerPath)}
exit 0
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        HAPPIER_STACK_REPO_DIR: tmp,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
    });

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    assert.ok(state.pid > 0, `expected a live daemon pid, got ${state.pid}`);

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /kickstart/);
    assert.match(launchctlLog, /com\.happier\.cli\.daemon\.default/);
    killDetachedProcessGroup(state.pid);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not bootstrap the installed service plist when the launchctl label is not loaded', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-bootstrap-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}
if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-bootstrap.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const launchctlRunnerPath = join(tmp, 'launchctl-bootstrap-runner.mjs');
    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const bootstrapMarkerPath = join(tmp, 'bootstrap-loaded.marker');
    await writeFile(
      launchctlRunnerPath,
      `
import { writeFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

writeFileSync(${JSON.stringify(bootstrapMarkerPath)}, '1\\n', 'utf-8');
spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
if [ "$1" = "kickstart" ]; then
  exit 113
fi
if [ "$1" = "start" ]; then
  exit 113
fi
if [ "$1" = "bootstrap" ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(launchctlRunnerPath)}
  exit 0
fi
exit 1
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /installed background service conflict|Failed to start daemon/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /kickstart/);
    assert.match(launchctlLog, /^start/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not enable a disabled installed service from daemon start recovery', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-enable-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}
if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-enable.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const launchctlRunnerPath = join(tmp, 'launchctl-enable-runner.mjs');
    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const enabledMarkerPath = join(tmp, 'launchctl-enabled.marker');
    await writeFile(
      launchctlRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
if [ "$1" = "kickstart" ]; then
  exit 113
fi
if [ "$1" = "start" ]; then
  exit 113
fi
if [ "$1" = "enable" ]; then
  : > ${JSON.stringify(enabledMarkerPath)}
  exit 0
fi
if [ "$1" = "bootstrap" ]; then
  if [ ! -f ${JSON.stringify(enabledMarkerPath)} ]; then
    echo "Bootstrap failed: 5: Input/output error" 1>&2
    exit 5
  fi
  ${JSON.stringify(process.execPath)} ${JSON.stringify(launchctlRunnerPath)}
  exit 0
fi
exit 1
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /installed background service conflict|Failed to start daemon/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /kickstart/);
    assert.match(launchctlLog, /^start/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not repair a stale installed service definition from daemon start recovery', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-repair-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const serviceRepairMarkerPath = join(tmp, 'service-repair.marker');
    const serviceCommandLogPath = join(tmp, 'service-command.log');
    const serviceStartRunnerPath = join(tmp, 'service-start-runner.mjs');
    await writeFile(
      serviceStartRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(serviceCommandLogPath)}, \`\${args.join(' ')} [channel=\${process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? ''}]\\n\`, 'utf-8');

if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}

if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'repair' && args.includes('--yes')) {
  writeFileSync(${JSON.stringify(serviceRepairMarkerPath)}, 'repaired\\n', 'utf-8');
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'start') {
  if (!existsSync(${JSON.stringify(serviceRepairMarkerPath)})) {
    process.exit(41);
  }
  const child = spawn(process.execPath, [${JSON.stringify(serviceStartRunnerPath)}], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-repair.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
exit 113
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /hstack service repair --yes/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /^kickstart/m);
    assert.match(launchctlLog, /^start/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);

    const serviceCommands = await readFile(serviceCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon start \[channel=\]$/m);
    assert.doesNotMatch(serviceCommands, /^service repair --yes/m);
    assert.doesNotMatch(serviceCommands, /^service start/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth diagnoses a launchctl-missing installed service label without repairing it', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-materialization-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const launchAgentPath = join(tmp, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
    await mkdir(dirname(launchAgentPath), { recursive: true });
    await writeFile(launchAgentPath, '<plist version="1.0"></plist>\n', 'utf-8');

    const serviceCommandLogPath = join(tmp, 'service-command.log');
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(serviceCommandLogPath)}, \`\${args.join(' ')} [channel=\${process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? ''}]\\n\`, 'utf-8');

if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — ${launchAgentPath}');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}

if (args[0] === 'daemon' && (args[1] === 'stop' || args[1] === 'status')) {
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-materialization.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
if [ "$1" = "kickstart" ] || [ "$1" = "start" ]; then
  echo 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501' 1>&2
  exit 113
fi
if [ "$1" = "print" ]; then
  echo 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501' 1>&2
  exit 113
fi
exit 1
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /launchd does not currently know label|service repair --yes/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /^kickstart/m);
    assert.match(launchctlLog, /^start/m);
    assert.match(launchctlLog, /^print/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);

    const serviceCommands = await readFile(serviceCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon start \[channel=\]$/m);
    assert.doesNotMatch(serviceCommands, /^service repair --yes/m);
    assert.doesNotMatch(serviceCommands, /^service start/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not repair service-managed owner conflicts reported by daemon ownership preflight', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-owner-conflict-repair-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const serviceRepairMarkerPath = join(tmp, 'service-repair.marker');
    const serviceCommandLogPath = join(tmp, 'service-command.log');
    const serviceStartRunnerPath = join(tmp, 'service-start-runner.mjs');
    await writeFile(
      serviceStartRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(serviceCommandLogPath)}, \`\${args.join(' ')} [channel=\${process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? ''}]\\n\`, 'utf-8');

if (args[0] === 'daemon' && args[1] === 'start') {
  const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
  const logsDir = \`\${home}/logs\`;
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    \`\${logsDir}/\${Date.now()}-pid-\${process.pid}-daemon.log\`,
    [
      'The current relay owner is managed by a background service.',
      '  Current owner: background service',
      '  Current release channel: stable',
      '  Current CLI version: 0.2.0',
      '  Background service label: com.happier.cli.daemon.default',
      '  Use \`happier service stop\` instead of \`happier daemon stop\`.',
      '',
    ].join('\\n'),
    'utf-8',
  );
  console.error('The current relay owner is managed by a background service.');
  console.error('  Current owner: background service');
  console.error('  Current release channel: stable');
  console.error('  Current CLI version: 0.2.0');
  console.error('  Background service label: com.happier.cli.daemon.default');
  console.error('  Use \`happier service stop\` instead of \`happier daemon stop\`.');
  process.exit(1);
}

if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'repair' && args.includes('--yes')) {
  writeFileSync(${JSON.stringify(serviceRepairMarkerPath)}, 'repaired\\n', 'utf-8');
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'start') {
  if (!existsSync(${JSON.stringify(serviceRepairMarkerPath)})) {
    process.exit(41);
  }
  const child = spawn(process.execPath, [${JSON.stringify(serviceStartRunnerPath)}], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...createFixtureStackEnv(tmp),
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /Use `happier service stop` instead of `happier daemon stop`\./,
    );

    const serviceCommands = await readFile(serviceCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon start \[channel=\]$/m);
    assert.doesNotMatch(serviceCommands, /^service repair --yes/m);
    assert.doesNotMatch(serviceCommands, /^service start/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth surfaces already-running daemon in TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
const dummy = spawnDaemonLikeProcess({
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  statePaths: [statePath],
});

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    // This status fixture supplies its executable process boundary directly;
    // source publication is exercised by the source-runtime fixtures.
    cliCommand: process.execPath,
    cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: {
      ...process.env,
      HAPPIER_STACK_TUI: '1',
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
} finally {
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.match(res.stdout + res.stderr, /\[daemon\] .*already running/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves an existing running daemon when requested', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-preserve-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner-preserve.mjs');
    await writeFile(
      runnerPath,
      `
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const staleServerUrl = 'http://127.0.0.1:4300';
const publicServerUrl = 'http://localhost:4301';
const control = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.statusCode = 401;
  res.end();
});
await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));

const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
  env: {
    ...process.env,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_SERVER_URL: staleServerUrl,
    HAPPIER_WEBAPP_URL: publicServerUrl,
  },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});

mkdirSync(join(cliHomeDir, 'servers', 'stack_dev__id_default'), { recursive: true });
writeFileSync(
  join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json'),
  JSON.stringify({
    pid: dummy.pid,
    httpPort: control.address().port,
    controlToken: 'state-token',
    startedAt: Date.now(),
    startedWithCliVersion: 'test',
  }) + '\\n',
  'utf-8'
);

try {
  const outcome = await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliEntrypoint: ${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))},
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    preserveExistingRunning: true,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '200',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
  assert.deepEqual(outcome, { started: false });
  process.kill(dummy.pid, 0);
  console.log('dummy-alive');
} finally {
  await new Promise((resolve) => control.close(resolve));
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /dummy-alive/);
    assert.match(res.stdout + res.stderr, /keeping existing daemon/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps a background-service-owned daemon when the selected webapp origin differs from the API origin', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliCommandLogPath = join(tmp, 'cli-command.log');

    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync } from 'node:fs';

appendFileSync(${JSON.stringify(cliCommandLogPath)}, process.argv.slice(2).join(' ') + '\\n', 'utf-8');
process.exit(0);
      `.trimStart(),
      'utf-8',
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'service-owned-runner.mjs');
    await writeFile(
      runnerPath,
      `
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';
const selectedWebappOrigin = 'http://happier-dev.localhost:19364';

const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
const dummy = spawnDaemonLikeProcess({
  cliHomeDir,
  statePaths: [statePath],
  internalServerUrl: 'http://qa-stack.localhost:4301/path?ignored=true',
  publicServerUrl: selectedWebappOrigin,
  env: {
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: 'com.happier.cli.daemon.default',
  },
});

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliCommand: process.execPath,
    cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_WEBAPP_URL: selectedWebappOrigin,
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
} finally {
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
      `.trimStart(),
      'utf-8',
    );

    const result = await runNode([runnerPath], {
      cwd: tmp,
      env: {
        ...process.env,
      },
    });

    assert.equal(result.code, 0, `expected exit 0, got ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    const serviceCommands = existsSync(cliCommandLogPath)
      ? await readFile(cliCommandLogPath, 'utf-8')
      : '';
    assert.doesNotMatch(serviceCommands, /^daemon (?:stop|start)$/m);
    assert.match(result.stdout, /daemon already running for stack home/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth refuses to replace a background-service-owned daemon for a genuinely different server URL', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-mismatch-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliCommandLogPath = join(tmp, 'cli-command.log');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const daemonStatePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliCommandLogPath)}, args.join(' ') + '\\n', 'utf-8');

if (args[0] === 'daemon' && args[1] === 'stop') {
  try {
    const state = JSON.parse(readFileSync(${JSON.stringify(daemonStatePath)}, 'utf-8'));
    killDetachedProcessGroup(Number(state?.pid));
  } catch {
    // The daemon may already be stopped.
  }
  rmSync(${JSON.stringify(daemonStatePath)}, { force: true });
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'start') {
  spawnDaemonLikeProcess({
    cliHomeDir: ${JSON.stringify(join(tmp, 'stack', 'cli'))},
    statePaths: [${JSON.stringify(daemonStatePath)}],
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
  });
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'service-owned-mismatch-runner.mjs');
    await writeFile(
      runnerPath,
      `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const statePath = ${JSON.stringify(daemonStatePath)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const existing = spawnDaemonLikeProcess({
  cliHomeDir,
  statePaths: [statePath],
  internalServerUrl: 'http://127.0.0.1:9999',
  publicServerUrl,
  env: {
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: 'com.happier.cli.daemon.default',
  },
});

try {
  await assert.rejects(
    startLocalDaemonWithAuth({
      cliBin: ${JSON.stringify(cliBin)},
      cliCommand: process.execPath,
      cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: false,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    }),
    (error) => error?.code === 'ESTACKDAEMONENVIRONMENTMISMATCH'
      && /hstack stack daemon dev restart/.test(error.message),
  );

  const currentState = JSON.parse(readFileSync(statePath, 'utf-8'));
  assert.equal(currentState.pid, existing.pid);
  process.kill(existing.pid, 0);
} finally {
  try {
    process.kill(-existing.pid, 'SIGKILL');
  } catch {
    // ignore
  }

  try {
    const currentState = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (currentState?.pid && currentState.pid !== existing.pid) {
      process.kill(-currentState.pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }
}
      `.trimStart(),
      'utf-8',
    );

    const result = await runNode([runnerPath], {
      cwd: tmp,
      env: {
        ...process.env,
      },
    });

    assert.equal(result.code, 0, `expected exit 0, got ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.equal(existsSync(cliCommandLogPath), false, 'expected no daemon stop/start command for an ordinary invocation mismatch');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth allows slower binary daemon startups by default', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-start-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 16_000 }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth allows slower runtime JS daemon startups by default', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-js-start-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 12_000 }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: cliCommandScript,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth allows slower source daemon startups by default', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-source-start-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const childPidPath = join(tmp, 'daemon-child.pid');
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');

  try {
    const monoRoot = tmp;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: '{}\n',
      binHappierScript: 'process.exit(42);\n',
      distIndexScript: buildDelayedDaemonStartCliScript({
        cliHomeDir,
        startDelayMs: 6_000,
        childPidPath,
      }),
    });
    const cliBin = join(cliBinDir, 'happier.mjs');

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...createFixtureStackEnv(tmp),
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
  } finally {
    try {
      const pid = Number(await readFile(childPidPath, 'utf-8'));
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth tolerates transient non-zero direct-executable starts when the daemon becomes running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-nonzero-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 5,
      machineId: 'test-machine',
      activeServerId: 'stack_dev__id_default',
      servers: {
        stack_dev__id_default: {
          id: 'stack_dev__id_default',
          serverUrl: 'http://localhost:4301',
          localServerUrl: 'http://127.0.0.1:4301',
          webappUrl: 'http://localhost:4301',
        },
      },
    }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 2_000, startExitCode: 1 }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth gives nested daemon start the stack-owned readiness budget', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-nested-start-budget-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const childPidPath = join(tmp, 'daemon.pid');
  const outcomePath = join(tmp, 'nested-start-outcome.json');
  let childPid = null;

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      buildBudgetBoundDaemonStartCliScript({
        cliHomeDir,
        startDelayMs: 80,
        childPidPath,
        outcomePath,
      }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '20',
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1000',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    childPid = Number(await readFile(childPidPath, 'utf-8'));
    const outcome = JSON.parse(await readFile(outcomePath, 'utf-8'));
    assert.deepEqual(outcome, { outcome: 'started', waitMs: 1000 });
  } finally {
    if (Number.isFinite(childPid) && childPid > 1) {
      try {
        killDetachedProcessGroup(childPid, 'SIGKILL');
      } catch {
        // already stopped by the fixture cleanup
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

for (const { isTui, detached } of [
  { isTui: false, detached: false },
  { isTui: true, detached: false },
  { isTui: false, detached: true },
  { isTui: true, detached: true },
]) {
  test(`startLocalDaemonWithAuth preserves a live slow daemon startup beyond readiness checkpoints (TUI=${isTui}, detached=${detached})`, { timeout: 15_000 }, async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-slow-wrapper-'));
    const cliHomeDir = join(tmp, 'cli');
    const cliCommandScript = join(tmp, 'slow-daemon.mjs');
    const wrapperPidPath = join(tmp, 'wrapper.pid');
    try {
      await mkdir(cliHomeDir, { recursive: true });
      await mkdir(join(cliHomeDir, 'servers', 'stack_dev__id_default'), { recursive: true });
      await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n');
      await writeFile(cliCommandScript, detached
        ? buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 300, childPidPath: wrapperPidPath })
        : `
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'daemon' && process.argv[3] === 'start') {
  writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
}
${buildSynchronousDaemonStartCliScript({ cliHomeDir, startDelayMs: 300 })}`);

      await startLocalDaemonWithAuth({
        cliBin: cliCommandScript,
        cliCommand: process.execPath,
        cliCommandArgs: [cliCommandScript],
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        forceRestart: true,
        isShuttingDown: () => false,
        env: {
          ...createFixtureStackEnv(tmp),
          HAPPIER_STACK_TUI: isTui ? '1' : '0',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '100',
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      });
      const state = checkDaemonState(cliHomeDir, {
        serverUrl: 'http://127.0.0.1:4301',
        env: { HAPPIER_ACTIVE_SERVER_ID: 'stack_dev__id_default' },
      });
      assert.equal(state.status, 'running', 'a live startup must reach readiness after multiple checkpoints');
      assert.equal(state.pid, Number(await readFile(wrapperPidPath, 'utf-8')));
    } finally {
      if (existsSync(wrapperPidPath)) {
        killDetachedProcessGroup(Number(await readFile(wrapperPidPath, 'utf-8')), 'SIGKILL');
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('startLocalDaemonWithAuth returns once a synchronous daemon start command becomes stably running', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-sync-running-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const runnerPath = join(tmp, 'runner.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildSynchronousDaemonStartCliScript({ cliHomeDir, startDelayMs: 250 }),
      'utf-8',
    );

    await writeFile(
      runnerPath,
      `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: ${JSON.stringify(cliCommandScript)},
  cliHomeDir,
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_STACK: 'dev',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1500',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
  cliIdentity: 'default',
});

const state = JSON.parse(await readFile(statePath, 'utf-8'));
console.log(JSON.stringify({ ok: true, pid: state.pid }));
process.kill(state.pid, 'SIGTERM');
      `.trimStart(),
      'utf-8'
    );

    const res = await runNodeWithTimeout([runnerPath], {
      cwd: tmp,
      env: process.env,
      timeoutMs: 15_000,
    });

    assert.equal(res.timedOut, false, `runner should not hang once daemon becomes running\n${res.stdout}\n${res.stderr}`);
    assert.equal(res.code, 0, `runner should exit cleanly\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /"ok":true/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('checkDaemonState ignores running daemon state from a different active server scope', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  await mkdir(cliHomeDir, { recursive: true });

  const dummy = spawnDetachedInlineNodeTestProcess('setInterval(()=>{}, 1e6)', {
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: 'http://127.0.0.1:4301',
      HAPPIER_WEBAPP_URL: 'http://localhost:4301',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    const serverDir = join(cliHomeDir, 'servers', 'stack_dev__id_default');
    await mkdir(serverDir, { recursive: true });
    await writeFile(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify({ pid: dummy.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\n',
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev2__id_default',
    };
    const state = checkDaemonState(cliHomeDir, { serverUrl: 'http://127.0.0.1:4301', env });
    assert.deepEqual(state, { status: 'stopped', pid: null });
  } finally {
    try {
      process.kill(-dummy.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
