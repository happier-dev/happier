// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, watch } from 'node:fs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { resolveDevTargetMutagenRuntime } from './utils/dev_targets/mutagen_runtime.mjs';
import { pickNextFreeTcpPort } from './utils/net/ports.mjs';
import { withJsonOwnerFileLock } from './utils/proc/jsonOwnerFileLock.mjs';
import { markDependencyMutation, withDependencyRefreshLock } from './utils/proc/dependency_refresh.mjs';
import { resolveStackCleanupExecutorLockTimeoutMs } from './utils/stack/stop.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../packages/cli-common/fileChangeObserver.mjs';

import * as stackEnvRunner from './stack/run_script_with_stack_env.mjs';
import { SOURCE_START_SUPERSEDED_MARKER } from './runtime/shared/pending_source_start.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { isPidAlive } from './utils/stack/runtime_state.mjs';

test('same-stack allocation reuses its previous free controller port across launches', async () => {
  const changes = [];
  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: 3009, preferredServerPort: 43123,
    reservedPorts: new Set([43124]),
    observeTcpPortAvailabilityImpl: async () => ({ status: 'free' }),
    pickNextFreeTcpPortImpl: async () => 43124,
    isTcpPortFreeImpl: async () => true,
    onPortChange: change => changes.push(change),
  });
  assert.equal(selected, 43123);
  assert.deepEqual(changes, []);
});

test('same-stack allocation moves a remembered controller port reserved by another stack', async () => {
  const reservedPorts = new Set([43123, 43124]);
  const changes = [];
  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: 43123, preferredServerPort: 43123, reservedPorts,
    // A reservation excludes even a socket that would currently probe free.
    observeTcpPortAvailabilityImpl: async () => ({ status: 'free' }),
    onPortChange: change => changes.push(change),
  });
  assert.equal(reservedPorts.has(selected), false);
  assert.deepEqual(changes, [{ previousPort: 43123, port: selected, reason: 'previous-port-occupied' }]);
});

test('same-stack allocation reports a foreign occupied controller port and leaves it alone', async () => {
  const changes = [];
  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: 3009, preferredServerPort: 43123,
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied', reason: 'address-in-use' }),
    pickNextFreeTcpPortImpl: async () => 43124,
    isTcpPortFreeImpl: async () => true,
    onPortChange: change => changes.push(change),
  });
  assert.equal(selected, 43124);
  assert.deepEqual(changes, [{ previousPort: 43123, port: 43124, reason: 'previous-port-occupied' }]);
});

test('same-stack allocation fails closed on inconclusive previous-port availability', async () => {
  await assert.rejects(stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: 3009, preferredServerPort: 43123,
    observeTcpPortAvailabilityImpl: async () => ({ status: 'inconclusive', reason: 'interface-inventory-unavailable' }),
    pickNextFreeTcpPortImpl: async () => 43124,
    isTcpPortFreeImpl: async () => true,
  }), error => error.code === 'EPORTSELECTIONINCONCLUSIVE');
});

test('a stopped or rebooted stack reuses its controller socket through real foreground launches', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-controller-relaunch-' });
  const stackName = 'controller-relaunch';
  const storageDir = fixture.path('stacks');
  const baseDir = join(storageDir, stackName);
  const statePath = join(baseDir, 'stack.runtime.json');
  const marker = fixture.path('controller-port');
  const env = { HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
    HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    HAPPIER_STACK_DAEMON: '0', HAPPIER_STACK_STOP_AUTO_SWEEP: '0' };
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: fixture.root });
  for (const directory of [baseDir, join(baseDir, 'cli'), fixture.path('scripts'),
    ...['cli', 'server', 'ui'].map(app => fixture.path('apps', app))]) await mkdir(directory, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  for (const app of ['cli', 'server', 'ui']) await writeFile(fixture.path('apps', app, 'package.json'), '{}');
  await writeFile(join(baseDir, 'env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
  const previousPort = await pickNextFreeTcpPort(43123);
  await writeFile(statePath, JSON.stringify({ version: 1, stackName, ownerPid: null, processes: {},
    portAllocations: { controller: { port: previousPort } } }));
  await writeFile(fixture.path('scripts', 'dev.mjs'),
    `import {createServer} from 'node:net'; import {writeFile} from 'node:fs/promises';
     const server=createServer(); server.listen(Number(process.env.HAPPIER_STACK_SERVER_PORT),'127.0.0.1',async()=>{
       await writeFile(${JSON.stringify(marker)},String(server.address().port)); server.close(); });`);
  for (const phase of ['start', 'restart', 'reboot']) {
    if (phase === 'reboot') {
      const bundleDir = fixture.path('retained-source');
      const cliDir = join(bundleDir, 'apps', 'cli');
      const entrypoint = join(cliDir, 'src', 'index.mjs');
      await mkdir(dirname(entrypoint), { recursive: true });
      await writeFile(entrypoint, 'throw new Error("retired source must not be launched");\n');
      await writeFile(join(bundleDir, 'source-bundle.json'), JSON.stringify({ dependencyPublication: null }));
      await writeFile(statePath, JSON.stringify({ version: 1, stackName, ownerPid: process.pid,
        startedAt: '1970-01-01T00:00:01.000Z', processes: { daemonPid: 2147483647 },
        sourceRuntimeLaunch: { entrypoint, cliDir, env: {} },
        portAllocations: { controller: { port: previousPort } },
        stopRequest: { requestedBy: 'restart', reason: 'reboot recovery', preserveDaemon: false,
          requestedAt: new Date().toISOString() } }));
    }
    await rm(marker, { force: true });
    const args = phase === 'start' ? [] : ['--restart'];
    await stackEnvRunner.runStackScriptWithStackEnv({ rootDir: fixture.root, stackName, scriptPath: 'dev.mjs',
      args: [...args, '--no-daemon', '--no-ui', '--no-browser', '--no-dev-targets'] });
    assert.equal(Number(await readFile(marker, 'utf8')), previousPort);
    const stopped = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(stopped.portAllocations.controller.port, previousPort);
    assert.equal(stopped.ownerPid, null);
    assert.equal(stopped.ports, undefined);
  }
});

test('controller fallback keeps retained full-server auxiliary ports reserved', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-controller-auxiliary-' });
  const stackName = 'controller-auxiliary';
  const storageDir = fixture.path('stacks');
  const baseDir = join(storageDir, stackName);
  const statePath = join(baseDir, 'stack.runtime.json');
  const marker = fixture.path('bound-ports');
  const foreign = (await import('node:net')).createServer();
  await new Promise((resolve, reject) => foreign.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const previousPort = foreign.address().port;
  const backendPort = await pickNextFreeTcpPort(43123);
  const env = { HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
    HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
    HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_DAEMON: '0', HAPPIER_STACK_STOP_AUTO_SWEEP: '0' };
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_STACK_STACK_PORT_START: String(backendPort) });
  for (const directory of [baseDir, join(baseDir, 'cli'), fixture.path('scripts'),
    ...['cli', 'server', 'ui'].map(app => fixture.path('apps', app))]) await mkdir(directory, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  for (const app of ['cli', 'server', 'ui']) await writeFile(fixture.path('apps', app, 'package.json'), '{}');
  await writeFile(join(baseDir, 'env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
  await writeFile(statePath, JSON.stringify({ version: 1, stackName, ownerPid: null, processes: {},
    startedAt: new Date().toISOString(), ports: { server: previousPort, backend: backendPort } }));
  await writeFile(fixture.path('scripts', 'dev.mjs'),
    `import {createServer} from 'node:net'; import {writeFile} from 'node:fs/promises';
     const server=createServer(), backend=createServer();
     await new Promise(resolve=>server.listen(Number(process.env.HAPPIER_STACK_SERVER_PORT),'127.0.0.1',resolve));
     await new Promise(resolve=>backend.listen(Number(process.env.HAPPIER_STACK_SERVER_BACKEND_PORT),'127.0.0.1',resolve));
     await writeFile(${JSON.stringify(marker)},JSON.stringify([server.address().port,backend.address().port]));
     server.close(); backend.close();`);
  await stackEnvRunner.runStackScriptWithStackEnv({ rootDir: fixture.root, stackName, scriptPath: 'dev.mjs',
    args: ['--restart', '--no-daemon', '--no-ui', '--no-browser', '--no-dev-targets'] });
  const [controllerPort, selectedBackendPort] = JSON.parse(await readFile(marker, 'utf8'));
  assert.notEqual(controllerPort, backendPort);
  assert.notEqual(controllerPort, previousPort);
  assert.equal(selectedBackendPort, backendPort);
  assert.equal(foreign.listening, true);
});

for (const pinned of [false, true]) {
  test(`signed-out background start succeeds and leaves its runner alive (pinned=${pinned})`, { timeout: 15_000 }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-background-signin-' });
    const stackName = 'background-signin';
    const storageDir = fixture.path('stacks');
    const baseDir = join(storageDir, stackName);
    const cliHomeDir = join(baseDir, 'cli');
    const runtimeStatePath = join(baseDir, 'stack.runtime.json');
    const serverId = buildStackStableScopeId({ stackName });
    const port = await pickNextFreeTcpPort(40000);
    const url = ['http:', '', `127.0.0.1:${port}`].join('/');
    const env = {
      HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_DEV_PROXY: '0',
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_STOP_AUTO_SWEEP: '0',
      ...(pinned ? { HAPPIER_STACK_SERVER_PORT: String(port) } : {}),
    };
    withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: fixture.root,
      HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS: '1500' });
    for (const directory of [join(cliHomeDir, 'servers', serverId), fixture.path('scripts'),
      ...['cli', 'server', 'ui'].map(app => fixture.path('apps', app))]) await mkdir(directory, { recursive: true });
    await writeFile(fixture.path('package.json'), '{"private":true}');
    for (const app of ['cli', 'server', 'ui']) await writeFile(fixture.path('apps', app, 'package.json'), '{}');
    await writeFile(join(baseDir, 'env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
    await writeFile(join(cliHomeDir, 'servers', serverId, 'access.key'), JSON.stringify({ token: randomBytes(32).toString('hex') }));
    const descriptor = { v: 1, homeServerIdentityId: 'srv_background_home', revision: 1,
      canonicalServerUrl: url, endpoints: [{ kind: 'https', url }] };
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: serverId,
      servers: { [serverId]: { id: serverId, serverUrl: url, homeConnectionDescriptor: descriptor } } }));
    // Substitute only the runner process boundary: the launcher, publication,
    // authenticated readiness decision and cleanup path remain production code.
    await writeFile(fixture.path('scripts', 'dev.mjs'), `
      import { createServer } from 'node:http';
      import { recordStackRuntimeUpdate } from ${JSON.stringify(new URL('./utils/stack/runtime_state.mjs', import.meta.url).href)};
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/features/authenticated') return response.writeHead(${pinned ? 403 : 401}).end();
        response.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      });
      server.listen(Number(process.env.HAPPIER_STACK_SERVER_PORT), '127.0.0.1', async () => {
        await recordStackRuntimeUpdate(process.env.HAPPIER_STACK_RUNTIME_STATE_PATH, { processes: { serverPid: process.pid } });
      });
    `);
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(String(message)));
    let runnerPid;
    try {
      await stackEnvRunner.runStackScriptWithStackEnv({ rootDir: fixture.root, stackName, scriptPath: 'dev.mjs', background: true,
        args: ['--no-ui', '--no-browser', '--no-dev-targets'], extraEnv: env });
      const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
      runnerPid = runtime.ownerPid;
      assert.match(warnings.join('\n'), /server ready; CLI sign-in-required/);
      assert.doesNotMatch(warnings.join('\n'), /readiness failed|readiness is still pending/,
        'sign-in-required must settle as ready rather than time out waiting for a daemon');
      assert.equal(isPidAlive(runnerPid), true, 'the background runner must outlive the successful launcher');
      assert.equal(runtime.processes.serverPid, runnerPid);
    } finally {
      runnerPid ??= JSON.parse(await readFile(runtimeStatePath, 'utf8').catch(() => '{}')).ownerPid;
      if (runnerPid && isPidAlive(runnerPid)) process.kill(runnerPid, 'SIGTERM');
    }
  });
}

for (const pinned of [false, true]) {
  test(`background source runner preserves terminal supersession (pinned=${pinned})`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-background-superseded-' });
    const stackName = 'superseded-source';
    const storageDir = fixture.path('stacks');
    const baseDir = join(storageDir, stackName);
    const env = {
      HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
      HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_RUNTIME_MODE: 'source',
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '0',
      HAPPIER_STACK_STOP_AUTO_SWEEP: '0',
      ...(pinned ? { HAPPIER_STACK_SERVER_PORT: String(await pickNextFreeTcpPort(40000)) } : {}),
    };
    withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: fixture.root });
    for (const directory of [baseDir, join(baseDir, 'cli'), fixture.path('scripts'),
      ...['cli', 'server', 'ui'].map(app => fixture.path('apps', app))]) await mkdir(directory, { recursive: true });
    await writeFile(fixture.path('package.json'), '{"private":true}');
    for (const app of ['cli', 'server', 'ui']) await writeFile(fixture.path('apps', app, 'package.json'), '{}');
    await writeFile(join(baseDir, 'env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
    // The subprocess emits the canonical runner terminal result before any
    // service exists. The background wrapper and error propagation stay real.
    await writeFile(fixture.path('scripts', 'run.mjs'), `process.stdout.write(${JSON.stringify(SOURCE_START_SUPERSEDED_MARKER + '\n')});`);
    const result = await runNodeCapture(['--input-type=module', '-e', `
      import { runStackScriptWithStackEnv } from ${JSON.stringify(new URL('./stack/run_script_with_stack_env.mjs', import.meta.url).href)};
      try {
        await runStackScriptWithStackEnv(${JSON.stringify({ rootDir: fixture.root, stackName, scriptPath: 'run.mjs', background: true,
          args: ['--runtime=source', '--reuse-source-runtime', '--no-daemon', '--no-ui', '--no-browser'], extraEnv: env })});
        process.exit(0);
      } catch (error) {
        console.log('WRAPPER_RESULT=' + JSON.stringify({ code: error.code ?? null }));
        process.exit(1);
      }
    `], { env: process.env });
    assert.equal(result.code, 1, result.stderr);
    const terminal = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('WRAPPER_RESULT=')).slice('WRAPPER_RESULT='.length));
    assert.equal(terminal.code, 'ESOURCESTARTSUPERSEDED', 'background launch must retain the terminal source-start result');
  });
}

test('restarting selected source never enters fresh-source preparation', { timeout: 15_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reuse-selected-source-' });
  const stackName = 'reuse-selected-source';
  const storageDir = fixture.path('stacks');
  const baseDir = join(storageDir, stackName);
  const marker = fixture.path('selected-runner-started');
  const env = { HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
    HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    HAPPIER_STACK_DAEMON: '0', HAPPIER_STACK_STOP_AUTO_SWEEP: '0' };
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: fixture.root });
  for (const directory of [baseDir, join(baseDir, 'cli'), fixture.path('scripts'),
    ...['cli', 'server', 'ui'].map(app => fixture.path('apps', app))]) await mkdir(directory, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  for (const app of ['cli', 'server', 'ui']) await writeFile(fixture.path('apps', app, 'package.json'), '{}');
  await writeFile(join(baseDir, 'env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
  // The launched runner is an OS/process boundary. A source capture here is a
  // defect: this minimal repository deliberately has no new source to build.
  await writeFile(fixture.path('scripts', 'run.mjs'), `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'started');`);
  await stackEnvRunner.runStackScriptWithStackEnv({ rootDir: fixture.root, stackName, scriptPath: 'run.mjs',
    args: ['--runtime=source', '--restart', '--reuse-source-runtime', '--no-dev-targets', '--no-server', '--no-ui', '--no-daemon', '--server-url=http://127.0.0.1:3005'] });
  assert.equal(await readFile(marker, 'utf8'), 'started');
  await assert.rejects(readFile(join(baseDir, 'source-runtime', 'reload.json')), error => error.code === 'ENOENT',
    'recovery must not create a fresh-source preparation record');
});

test('a placed prepared reload releases obsolete trees once the replacement is ready', { skip: process.platform === 'win32' }, async t => {
  const { rootDir, stackName, runtimeStatePath } = await createRestartPreflightFixture(t, 'run.mjs');
  const sourceRoot = join(dirname(runtimeStatePath), 'source-runtime');
  const entrypoints = {};
  for (const id of ['abcdef01', 'abcdef02', 'abcdef03']) {
    entrypoints[id] = join(sourceRoot, `tree-server-${id}/main.mjs`);
    await mkdir(dirname(entrypoints[id]), { recursive: true });
    await writeFile(entrypoints[id], '');
  }
  await writeFile(join(sourceRoot, 'selected-server.json'), JSON.stringify({ entrypoint: entrypoints.abcdef03 }));
  await writeFile(join(sourceRoot, 'rollback.json'), JSON.stringify({ selections: { server: { entrypoint: entrypoints.abcdef02 } } }));
  const { createServer } = await import('node:http');
  const endpoint = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => endpoint.close());
  await writeFile(join(rootDir, 'scripts', 'run.mjs'), 'setInterval(() => {}, 1000);');
  try {
    const result = await stackEnvRunner.runStackScriptWithStackEnv({
      rootDir, stackName, scriptPath: 'run.mjs', background: true,
      args: ['--runtime=source', '--restart', '--reuse-source-runtime', '--prepared-source-reload',
        '--no-server', `--server-url=http://127.0.0.1:${endpoint.address().port}`,
        '--no-daemon', '--no-ui', '--no-browser', '--no-dev-targets'],
      extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' },
    });
    assert.equal(result.readiness, 'ready');
    await assert.rejects(readFile(entrypoints.abcdef01), { code: 'ENOENT' });
    assert.equal(await readFile(entrypoints.abcdef02, 'utf8'), '');
    assert.equal(await readFile(entrypoints.abcdef03, 'utf8'), '');
  } finally {
    const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
    if (runtime.ownerPid && isPidAlive(runtime.ownerPid)) process.kill(runtime.ownerPid, 'SIGTERM');
  }
});

test('restart waits for the cleanup completion signal beyond the standalone lock deadline', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-restart-completion-wait-' });
  const stackName = 'restart-completion-wait';
  const baseDir = fixture.path('stacks', stackName);
  const envPath = join(baseDir, 'env');
  const lockPath = join(baseDir, 'stack.cleanup-executor.lock');
  const waitersPath = `${lockPath}.waiters`;
  await mkdir(waitersPath, { recursive: true });
  for (const app of ['cli', 'server', 'ui']) await mkdir(fixture.path('apps', app), { recursive: true });
  const env = { HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'), HAPPIER_STACK_STOP_AUTO_SWEEP: '0' };
  await writeFile(envPath, Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
  const inheritedDeadline = resolveStackCleanupExecutorLockTimeoutMs({ env: {} });
  const clockNow = Date.now;
  // Keep the real holder fresh while advancing only the waiting process's
  // clock beyond the existing standalone command deadline.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import {once} from 'node:events';
    import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./utils/proc/jsonOwnerFileLock.mjs', import.meta.url).href)};
    const now=Date.now; Date.now=()=>now()+${inheritedDeadline * 2};
    await withJsonOwnerFileLock(async()=>{
      process.send('locked'); await once(process,'message');
    },{lockPath:${JSON.stringify(lockPath)}});
    process.disconnect();
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); await once(holder, 'exit'); }
  });
  await once(holder, 'message');
  const incumbent = { version: 1, stackName, ownerPid: null,
    startedAt: new Date().toISOString(), processes: {} };
  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify(incumbent));
  const watcher = watch(waitersPath);
  t.after(() => watcher.close());
  const queued = once(watcher, 'change');
  let outcome = null;
  const stopping = stackEnvRunner.stopObservedStackForRestart({ rootDir: fixture.root,
    stackName: incumbent.stackName, baseDir, incumbentRuntimeState: incumbent, json: true,
    env,
  }).then(value => { outcome = { ok: true, value }; }, error => { outcome = { ok: false, error }; });
  await queued;
  const clock = t.mock.method(Date, 'now', () => clockNow() + inheritedDeadline + 1);
  // A real competing ticket wakes the existing file-change observer.
  await assert.rejects(withJsonOwnerFileLock(async () => {}, { lockPath, wait: false }),
    error => error?.code === 'EJSONOWNERFILELOCKBUSY');
  await new Promise(resolve => setTimeout(resolve, DEFAULT_FILE_CHANGE_CATCH_UP_MS));
  assert.equal(outcome, null, 'restart must await cleanup rather than exhaust a standalone lock deadline');
  clock.mock.restore();
  holder.send('release');
  await stopping;
  assert.ifError(outcome?.error);
  assert.equal(outcome?.ok, true);
  assert.equal(outcome?.value.finalization?.finalized, true);
});

for (const successor of [false, true]) {
  test(`restart ${successor ? 'refuses a foreign cleanup' : 'completes its own late stop before claiming the replacement'}`, async t => {
    if (process.platform === 'win32') return t.skip('fixture requires a handled POSIX termination signal');
    const fixture = await createTempFixture(t, { prefix: 'hstack-restart-finalization-' });
    const rootDir = fixture.path('repo');
    const storageDir = fixture.path('stacks');
    const stackName = 'restart-finalization';
    const baseDir = join(storageDir, stackName);
    const envPath = join(baseDir, 'env');
    const cliHomeDir = join(baseDir, 'cli');
    const statePath = join(baseDir, 'stack.runtime.json');
    const markerPath = fixture.path('replacement-started');
    withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: rootDir });
    for (const path of [baseDir, cliHomeDir, join(rootDir, 'scripts'),
      ...['cli', 'server', 'ui'].map(app => join(rootDir, 'apps', app))]) await mkdir(path, { recursive: true });
    await writeFile(join(rootDir, 'package.json'), '{"private":true}\n');
    for (const app of ['cli', 'server', 'ui']) await writeFile(join(rootDir, 'apps', app, 'package.json'), '{}\n');
    const env = { HAPPIER_STACK_REPO_DIR: rootDir, HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_STACK_DAEMON: '0', HAPPIER_STACK_STOP_AUTO_SWEEP: '0' };
    await writeFile(envPath, Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
    // A real runner's shutdown projection can advance after the stop snapshot.
    // That invalidates the first finalization without changing its incarnation.
    const owner = spawn(process.execPath, ['--input-type=module', '-e', `
      import {readFile,writeFile} from 'node:fs/promises';
      process.on('SIGTERM', async () => {
        const path=${JSON.stringify(statePath)};
        const state=JSON.parse(await readFile(path,'utf8'));
        state.serverLifecycle={phase:'stopped'};
        ${successor ? `state.ownerPid=${process.pid}; state.startedAt='2026-10-25T18:00:00.001Z'; state.sentinel='foreign-cleanup';` : ''}
        await writeFile(path,JSON.stringify(state));
        process.exit(0);
      });
      process.send('ready');
      setInterval(()=>{},1000);
    `], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ...env, HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_PROCESS_KIND: 'infra', HAPPIER_HOME_DIR: cliHomeDir } });
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await once(owner, 'exit'); }
    });
    await once(owner, 'message');
    const { readProcessInstanceFingerprintSync } = await import('@happier-dev/cli-common/processInstance');
    await writeFile(statePath, JSON.stringify({ version: 1, stackName, ownerPid: owner.pid,
      startedAt: new Date().toISOString(), ports: { server: await pickNextFreeTcpPort(49291) },
      processes: {}, serverLifecycle: { phase: 'ready' },
      processInstances: { owner: { pid: owner.pid, fingerprint: readProcessInstanceFingerprintSync(owner.pid) } } }));
    await writeFile(join(rootDir, 'scripts', 'dev.mjs'),
      `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(markerPath)},'started');`);
    const restart = () => stackEnvRunner.runStackScriptWithStackEnv({ rootDir, stackName, scriptPath: 'dev.mjs',
      args: ['--restart', '--no-daemon', '--no-ui', '--no-browser', '--no-dev-targets'] });
    if (successor) {
      await assert.rejects(restart, error => error?.code === 'ESTACKRUNTIMECLEANUPINCOMPLETE');
      const retained = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(retained.ownerPid, process.pid);
      assert.equal(retained.sentinel, 'foreign-cleanup');
      assert.ok(retained.stopRequest);
      await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    } else {
      await restart();
      assert.equal(await readFile(markerPath, 'utf8'), 'started');
      const stopped = JSON.parse(await readFile(statePath, 'utf8'));
      assert.ok(stopped.portAllocations.controller.port > 0);
      assert.equal(stopped.ownerPid, null);
      assert.equal(stopped.ports, undefined);
    }
    assert.ok(owner.exitCode !== null || owner.signalCode !== null);
  });
}

for (const owned of [true, false]) {
  test(`restart swap ${owned ? 'retires its recorded orphan incumbent and binds' : 'moves around a foreign listener'}`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-restart-orphan-' });
    const storageDir = fixture.path('stacks');
    const rootDir = fixture.path('repo');
    const stackName = 'restart-orphan';
    const baseDir = join(storageDir, stackName);
    const envPath = join(baseDir, 'env');
    const cliHomeDir = join(baseDir, 'cli');
    const markerPath = fixture.path('replacement-bound');
    withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir, HAPPIER_STACK_REPO_DIR: rootDir });
    for (const path of [baseDir, cliHomeDir, join(rootDir, 'scripts'),
      ...['cli', 'server', 'ui'].map(app => join(rootDir, 'apps', app))]) await mkdir(path, { recursive: true });
    await writeFile(join(rootDir, 'package.json'), '{"private":true}\n');
    for (const app of ['cli', 'server', 'ui']) await writeFile(join(rootDir, 'apps', app, 'package.json'), '{}\n');
    const env = { HAPPIER_STACK_REPO_DIR: rootDir, HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_STACK_DAEMON: '0' };
    await writeFile(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
    // Model a server detached from an earlier runner: its native identity remains
    // recorded, but there is no surviving controller PID to authorize by.
    const server = spawn(process.execPath, ['--input-type=module', '-e',
      "import {createServer} from 'node:net'; const s=createServer(); s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"], {
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
      env: owned ? { ...process.env, ...env, HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_PROCESS_KIND: 'infra', HAPPIER_HOME_DIR: cliHomeDir }
        : { PATH: process.env.PATH },
    });
    t.after(async () => { if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await once(server, 'exit'); } });
    const [chunk] = await once(server.stdout, 'data');
    const port = Number(String(chunk).trim());
    assert.ok(port > 0);
    const { readProcessInstanceFingerprintSync } = await import('@happier-dev/cli-common/processInstance');
    const incumbent = { version: 1, stackName, ownerPid: null,
      startedAt: '2026-10-25T03:00:00.000Z', ports: { server: port },
      processes: owned ? { serverPid: server.pid } : {},
      processInstances: { processes: owned ? { serverPid: { pid: server.pid,
        fingerprint: readProcessInstanceFingerprintSync(server.pid) } } : {} } };
    await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify(incumbent));
    await writeFile(join(rootDir, 'scripts', 'dev.mjs'),
      `import {createServer} from 'node:net'; import {writeFile} from 'node:fs/promises';
       const server=createServer(); server.listen(Number(process.env.HAPPIER_STACK_SERVER_PORT),'127.0.0.1',async()=>{
         await writeFile(${JSON.stringify(markerPath)},String(server.address().port)); server.close(); });`);
    const restart = () => stackEnvRunner.runStackScriptWithStackEnv({ rootDir, stackName, scriptPath: 'dev.mjs',
      args: ['--restart', '--no-daemon', '--no-ui', '--no-browser', '--no-dev-targets'] });
    if (owned) {
      await restart();
      assert.equal(await readFile(markerPath, 'utf8'), String(port));
      assert.ok(server.exitCode !== null || server.signalCode !== null, 'incumbent must exit before replacement binds');
    } else {
      await restart();
      const selectedPort = Number(await readFile(markerPath, 'utf8'));
      assert.notEqual(selectedPort, port);
      assert.equal(server.exitCode, null);
      assert.equal(server.signalCode, null);
      const stopped = JSON.parse(await readFile(join(baseDir, 'stack.runtime.json'), 'utf8'));
      assert.deepEqual(stopped.portAllocations.controller, { port: selectedPort, previousPort: port, reason: 'previous-port-occupied' });
    }
  });
}

async function createRestartPreflightFixture(t, scriptPath) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-restart-preflight-' });
  const storageDir = fixture.path('stacks');
  const rootDir = fixture.path('repo');
  const stackName = 'restart-preflight';
  const baseDir = join(storageDir, stackName);
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const markerPath = fixture.path('replacement-started');
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_REPO_DIR: rootDir });
  const env = {
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer',
    HAPPIER_STACK_RUNTIME_MODE: 'source-snapshot',
    HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
    HAPPIER_STACK_DAEMON: '0',
  };
  const config = { version: 3,
    targets: [{ name: 'remote', platform: 'posix', ssh: 'fixture.invalid',
      repoDir: '/mirror', cliHomeDir: '/state' }],
    runtimePlacement: { server: { mode: 'prefer-target', target: 'remote', fallback: 'local' },
      daemon: { mode: 'local' } }, commandExecution: { mode: 'local' },
  };
  for (const path of [baseDir, join(storageDir, 'producer'), join(rootDir, 'scripts'),
    ...['cli', 'server', 'ui'].map(app => join(rootDir, 'apps', app))]) await mkdir(path, { recursive: true });
  await writeFile(join(rootDir, 'package.json'), '{"private":true}\n');
  for (const app of ['cli', 'server', 'ui']) {
    await writeFile(join(rootDir, 'apps', app, 'package.json'), '{"private":true}\n');
  }
  await writeFile(join(baseDir, 'env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  for (const name of [stackName, 'producer']) {
    await writeFile(join(storageDir, name, 'dev-targets.json'), JSON.stringify(config));
  }
  // This is an inert runner fixture, not a stack/server. No fixture process
  // needs signaling: a successful dispatch writes the marker and exits itself.
  await writeFile(join(rootDir, 'scripts', scriptPath),
    `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(markerPath)}, 'started');`);
  const sync = resolveDevTargetMutagenRuntime({ stackBaseDir: baseDir, sourceDir: rootDir, env });
  await mkdir(dirname(sync.projectFile), { recursive: true });
  await writeFile(sync.projectFile, '# disposable existing producer project\n');
  // A recorded port selects the real restart path without creating any live
  // process to stop. Invalid owner identity deliberately forbids signals.
  const incumbent = { version: 1, stackName, ownerPid: null,
    startedAt: '2026-10-21T10:00:00.000Z', ports: { server: await pickNextFreeTcpPort(49191) },
    sentinel: 'incumbent', processes: {} };
  await writeFile(runtimeStatePath, JSON.stringify(incumbent));
  return { rootDir, stackName, runtimeStatePath, markerPath, incumbent };
}

test('dev restart cannot retire the build producer while another stack holds its lease', async t => {
  const { rootDir, stackName, runtimeStatePath, markerPath, incumbent } = await createRestartPreflightFixture(t, 'dev.mjs');
  const { sourceRuntimeProducerBuildLockPath } = await import('./build/build_source_runtime.mjs');
  const { withWorkspaceBundleLock } = await import('../../../packages/cli-common/workspaceBundleLock.mjs');
  const lockPath = sourceRuntimeProducerBuildLockPath(dirname(runtimeStatePath));
  const input = {
    rootDir, stackName, scriptPath: 'dev.mjs',
    args: ['--restart', '--no-dev-targets', '--no-daemon', '--no-ui', '--no-browser'],
    extraEnv: { HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: stackName },
  };
  await withWorkspaceBundleLock(async () => {
    await assert.rejects(stackEnvRunner.runStackScriptWithStackEnv(input), { code: 'EWORKSPACEBUNDLELOCKBUSY' });
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), incumbent);
  }, { lockPath, staleAfterMs: Infinity });
  await stackEnvRunner.runStackScriptWithStackEnv(input);
  assert.equal(await readFile(markerPath, 'utf8'), 'started');
});

for (const scriptPath of ['run.mjs', 'dev.mjs']) {
  test(`${scriptPath} restart refuses unavailable placement/sync before replacing incumbent state`, async t => {
    const { rootDir, stackName, runtimeStatePath, markerPath, incumbent } = await createRestartPreflightFixture(t, scriptPath);
    const probes = [];
    const observe = async kind => {
      probes.push(kind);
      assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), incumbent,
        'readiness must observe the incumbent before any stop/publication');
    };
    await assert.rejects(stackEnvRunner.runStackScriptWithStackEnv({
      rootDir, stackName, scriptPath,
      args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
      // Prepared source admission is not fresh placement/sync readiness.
      extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
    }, {
      // Only external command boundaries are simulated; configuration,
      // placement selection, sync admission and outer restart wiring are real.
      runCaptureResult: async () => {
        await observe('placement');
        return { ok: false, exitCode: 1, err: 'fixture sync conflict' };
      },
      runProcess: async ({ args }) => {
        await observe(`sync:${args[1]}`);
        if (args[1] === 'flush') return { code: 1, out: '', err: 'fixture sync conflict' };
        return { code: 0, out: JSON.stringify([{ name: args[2], paused: false,
          status: 'watching', successfulCycles: 1,
          alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
      },
    }), scriptPath === 'run.mjs' ? /fixture sync conflict/ : /Mutagen initial flush failed/);
    assert.equal(probes.length > 0, true);
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), incumbent);

    // The same restart proceeds after the external readiness boundary recovers;
    // the correction must not simply disable replacement launches.
    probes.length = 0;
    await stackEnvRunner.runStackScriptWithStackEnv({
      rootDir, stackName, scriptPath,
      args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
      extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
    }, {
      runCaptureResult: async () => {
        await observe('placement');
        return { ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\n', err: '' };
      },
      runProcess: async ({ args }) => {
        await observe(`sync:${args[1]}`);
        return { code: 0, out: JSON.stringify([{ name: args[2], paused: false,
          status: 'watching', successfulCycles: 1,
          alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
      },
    });
    assert.equal(await readFile(markerPath, 'utf8'), 'started');
    // agent-qa-usage-insights reload 201: the replacement's ~10 min sync wait ran
    // after retirement. A source reload flushes the placed target before retiring.
    assert.deepEqual(probes, scriptPath === 'run.mjs'
      ? ['placement', 'sync:list', 'sync:list', 'sync:flush'] : ['sync:list', 'sync:list', 'sync:flush']);
  });
}

test('a source reload waits for an active dependency refresh before any retirement step', async t => {
  // agent-qa-usage-insights reload 201: the replacement waited ~6 min on the
  // controller dependency-refresh lock after the incumbent had been retired.
  const { rootDir, stackName, markerPath } = await createRestartPreflightFixture(t, 'run.mjs');
  const env = { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '' };
  let held;
  const writerHeld = new Promise(resolve => { held = resolve; });
  let releaseWriter;
  const released = new Promise(resolve => { releaseWriter = resolve; });
  const writer = withDependencyRefreshLock({ installDir: rootDir, env }, async () => {
    await markDependencyMutation({ installDir: rootDir, env });
    held();
    await released;
  });
  await writerHeld;
  const probes = [];
  const restart = stackEnvRunner.runStackScriptWithStackEnv({
    rootDir, stackName, scriptPath: 'run.mjs',
    args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
    extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
  }, {
    runCaptureResult: async () => {
      probes.push('placement');
      return { ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\n', err: '' };
    },
    runProcess: async ({ args }) => {
      probes.push(`sync:${args[1]}`);
      return { code: 0, out: JSON.stringify([{ name: args[2], paused: false,
        status: 'watching', successfulCycles: 1,
        alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
    },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.deepEqual(probes, [], 'no placement, sync or retirement step runs while a dependency writer is active');
  } finally {
    releaseWriter();
    await writer;
  }
  await restart;
  assert.equal(await readFile(markerPath, 'utf8'), 'started');
  assert.deepEqual(probes, ['placement', 'sync:list', 'sync:list', 'sync:flush']);
});

test('a reload whose replacement fails readiness after retirement restarts the incumbent revision', async t => {
  // P03 ORCH 2026-11-17: retirement is followed only by start and readiness;
  // when that fails, the reload restarts the still-prepared incumbent revision.
  const { rootDir, stackName, runtimeStatePath, markerPath } = await createRestartPreflightFixture(t, 'run.mjs');
  const sourceRoot = join(dirname(runtimeStatePath), 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const selection = join(sourceRoot, 'selected-server.json');
  const entries = {};
  for (const name of ['incumbent', 'replacement']) {
    entries[name] = join(dirname(markerPath), `${name}/main.mjs`);
    await mkdir(dirname(entries[name]), { recursive: true });
    await writeFile(entries[name], '');
  }
  // Preparation recorded the incumbent's selection, then activated the replacement.
  await writeFile(selection, JSON.stringify({ entrypoint: entries.incumbent }));
  const { recordSourceSelectionRollback } = await import('./runtime/shared/source_selection_rollback.mjs');
  await recordSourceSelectionRollback({ stackBaseDir: dirname(runtimeStatePath) });
  await writeFile(selection, JSON.stringify({ entrypoint: entries.replacement }));
  // Inert runner fixture: it records what each launch would serve, then exits
  // before readiness (a replacement that cannot become ready).
  await writeFile(join(rootDir, 'scripts', 'run.mjs'), `import {appendFile, readFile} from 'node:fs/promises';
    const selected = JSON.parse(await readFile(${JSON.stringify(selection)}, 'utf8')).entrypoint;
    await appendFile(${JSON.stringify(markerPath)}, JSON.stringify({ selected,
      rollback: process.env.HAPPIER_STACK_SOURCE_SELECTION_ROLLBACK ?? null }) + '\\n');
    process.exit(1);`);
  const healthy = { code: 0, out: JSON.stringify([{ name: 'remote', paused: false, status: 'watching', successfulCycles: 1,
    alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
  await assert.rejects(stackEnvRunner.runStackScriptWithStackEnv({
    rootDir, stackName, scriptPath: 'run.mjs', background: true,
    args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
    extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
  }, {
    runCaptureResult: async () => ({ ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\n', err: '' }),
    runProcess: async () => healthy,
  }), { code: 'ESOURCERELOADROLLBACKFAILED' });
  const launches = (await readFile(markerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(launches, [
    { selected: entries.replacement, rollback: null },
    { selected: entries.incumbent, rollback: '1' },
  ]);
});

test('a restart retires browsers only after it launched the replacement, never on the stop critical path', async t => {
  // P03 ORCH 2026-11-18: browser cleanup across every QA host (including an
  // unreachable one) must never delay a reload; it runs afterwards, logged.
  const { rootDir, stackName, markerPath } = await createRestartPreflightFixture(t, 'run.mjs');
  const seen = [];
  const warn = console.warn;
  console.warn = (...values) => {
    const line = values.map(String).join(' ');
    if (line.includes('browser_cleanup')) {
      seen.push({ line, launched: readFileSyncSafe(markerPath) === 'started' });
    }
  };
  t.after(() => { console.warn = warn; });
  await stackEnvRunner.runStackScriptWithStackEnv({
    rootDir, stackName, scriptPath: 'run.mjs',
    args: ['--restart', '--no-daemon', '--no-ui', '--no-browser'],
    extraEnv: { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' },
  }, {
    runCaptureResult: async () => ({ ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\n', err: '' }),
    runProcess: async ({ args }) => ({ code: 0, out: JSON.stringify([{ name: args[2], paused: false,
      status: 'watching', successfulCycles: 1,
      alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }),
  });
  assert.equal(await readFile(markerPath, 'utf8'), 'started');
  assert.ok(seen.length > 0, 'the unreachable fixture host reports its browser cleanup');
  assert.deepEqual(seen.map(entry => entry.launched), seen.map(() => true), 'browser cleanup ran after the replacement launched');
});

function readFileSyncSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

test('outer start publication records requested UI truth before the child runner starts', () => {
  const base = {
    stackName: 'runtime-ui',
    scriptPath: 'run.mjs',
    ephemeral: false,
    ownerPid: 4242,
    ports: { server: 4101 },
    runtimeSnapshotId: 'snapshot-1',
  };

  assert.equal(stackEnvRunner.createOuterStackRuntimeStartPublication({ ...base, args: ['--no-ui'], env: {} }).serveUi, false);
  assert.equal(
    stackEnvRunner.createOuterStackRuntimeStartPublication({
      ...base,
      args: [],
      env: { HAPPIER_STACK_SERVE_UI: '0' },
    }).serveUi,
    false,
  );
  assert.equal(stackEnvRunner.createOuterStackRuntimeStartPublication({ ...base, args: [], env: {} }).serveUi, true);
});

test('boot-failure cleanup awaits the canonical process-tree owner', async () => {
  const calls = [];
  const child = { pid: 4242, kill(signal) { calls.push(['leader-kill', signal]); } };
  const expectedRuntimeState = {
    ownerPid: 4242,
    startedAt: '2026-07-17T08:00:00.000Z',
  };

  const result = await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    expectedRuntimeState,
    killProcessTreeImpl: async (target, signal) => {
      calls.push(['tree-kill', target.pid, signal]);
      return { ok: true, signal };
    },
    finalizeStackRuntimeOwnerShutdownImpl: async (_path, expected) => {
      calls.push(['state-delete', expected]);
      return { deleted: true };
    },
  });

  assert.deepEqual(result, { ok: true, signal: 'SIGTERM' });
  assert.deepEqual(calls, [['tree-kill', 4242, 'SIGTERM'], ['state-delete', expectedRuntimeState]]);

  calls.length = 0;
  await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: true }),
    finalizeStackRuntimeOwnerShutdownImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(calls, [], 'missing pre-existing identity must not delete runtime state');

  calls.length = 0;
  const unconfirmed = await stackEnvRunner.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: 'C:\\stack\\stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: false, reason: 'tree_unconfirmed' }),
    finalizeStackRuntimeOwnerShutdownImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(unconfirmed, { ok: false, reason: 'tree_unconfirmed' });
  assert.deepEqual(calls, []);
});

test('hasRecordedRuntimePortsForRestart requires a positive server port', () => {
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart(null), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: {} }), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: { server: '0' } }), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: { server: '3010' } }), true);
});

test('shouldReuseRuntimePortsOnRestart reuses runtime ports on stale-owner restarts', () => {
  const runtimeState = { ownerPid: 999_999_999, ports: { server: 3010 } };
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState, wasRunning: false }),
    true
  );
});

test('shouldReuseRuntimePortsOnRestart stays false when restart was not requested', () => {
  const runtimeState = { ports: { server: 3010 } };
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: false, runtimeState, wasRunning: true }),
    false
  );
});

test('source reload preserves an omitted daemon and retires a requested remote replacement', () => {
  const incumbentRuntimeState = { remoteTargets: { nl3: {
    services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' },
  } } };
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      args: ['--restart', '--no-daemon'],
      preparedSourceRuntimeReload: { remote: true, remoteDaemon: true },
      incumbentRuntimeState,
    }),
    true,
    'a server-only restart must preserve the incumbent remote daemon',
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      env: { HAPPIER_STACK_DAEMON: '0' },
      preparedSourceRuntimeReload: { remote: true, remoteDaemon: true },
      incumbentRuntimeState,
    }),
    true,
    'the canonical environment-based daemon opt-out has the same preservation contract',
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      preparedSourceRuntimeReload: { remoteDaemon: true },
    }),
    false,
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      preparedSourceRuntimeReload: { remote: true, remoteDaemon: false },
    }),
    true,
    'a remote server alone does not transfer daemon retirement ownership',
  );
  assert.equal(
    stackEnvRunner.shouldPreserveDaemonForRestart({
      preparedSourceRuntimeReload: { remote: false, remoteDaemon: false },
      incumbentRuntimeState,
    }),
    false,
    'an incumbent remote daemon is retired even when replacement placement changed',
  );
  assert.equal(stackEnvRunner.shouldPreserveDaemonForRestart(), true);
});

test('fresh non-restart allocation excludes a remembered port held by a foreign listener', async () => {
  const staleForeignPort = 3012;
  const reservedPorts = new Set();
  const pickedPorts = [];
  const availabilityChecks = [];

  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: staleForeignPort,
    preferredServerPort: staleForeignPort,
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
    reservedPorts,
    pickNextFreeTcpPortImpl: async (_startPort, { reservedPorts: observedReservedPorts }) => {
      assert.ok(observedReservedPorts.has(staleForeignPort), 'stale runtime state must not select the foreign port');
      pickedPorts.push(3013);
      return 3013;
    },
    isTcpPortFreeImpl: async (port) => {
      availabilityChecks.push(port);
      return port === 3013;
    },
  });

  assert.equal(selected, 3013);
  assert.deepEqual(pickedPorts, [3013]);
  assert.deepEqual(availabilityChecks, [3013]);
  assert.ok(!availabilityChecks.includes(staleForeignPort), 'allocation must not claim the foreign listener');
  assert.ok(reservedPorts.has(3012));
});

test('fresh non-restart allocation retries one racy candidate', async () => {
  const reservedPorts = new Set();
  const pickedPorts = [];
  const availabilityChecks = [];
  const candidates = [3013, 3014];

  const selected = await stackEnvRunner.allocateFreshEphemeralServerPort({
    startPort: 3012,
    preferredServerPort: 3012,
    observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
    reservedPorts,
    pickNextFreeTcpPortImpl: async () => {
      const next = candidates.shift();
      pickedPorts.push(next);
      return next;
    },
    isTcpPortFreeImpl: async (port) => {
      availabilityChecks.push(port);
      return port === 3014;
    },
  });

  assert.equal(selected, 3014);
  assert.deepEqual(pickedPorts, [3013, 3014]);
  assert.deepEqual(availabilityChecks, [3013, 3014]);
  assert.ok(reservedPorts.has(3013));
});

test('fresh non-restart allocation fails closed after its one bounded replacement', async () => {
  const pickedPorts = [];
  const candidates = [3013, 3014, 3015];

  await assert.rejects(
    () => stackEnvRunner.allocateFreshEphemeralServerPort({
      startPort: 3012,
      preferredServerPort: 3012,
      observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied' }),
      reservedPorts: new Set(),
      pickNextFreeTcpPortImpl: async () => {
        const next = candidates.shift();
        pickedPorts.push(next);
        return next;
      },
      isTcpPortFreeImpl: async () => false,
    }),
    /unable to allocate a free server port after a bounded retry/,
  );

  assert.deepEqual(pickedPorts, [3013, 3014]);
});

test('stopped-stack restart cannot authorize the outer destructive stop path', async () => {
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState: null, wasRunning: false }),
    false,
  );

  const source = await readFile(new URL('./stack/run_script_with_stack_env.mjs', import.meta.url), 'utf8');
  const decisionBoundary = source.indexOf('const isTrueRestart =');
  const stopBoundary = source.indexOf('await stopObservedStackForRestart({', decisionBoundary);
  const stopGuardBoundary = source.lastIndexOf('if (isTrueRestart)', stopBoundary);
  assert.ok(
    decisionBoundary >= 0 && stopGuardBoundary > decisionBoundary && stopBoundary > stopGuardBoundary,
    'the canonical true-restart decision must guard the destructive outer stop',
  );
  assert.equal(
    (source.match(/await stopObservedStackForRestart\(/g) ?? []).length,
    2,
    'both restart cleanup paths must use the observed lifecycle fence',
  );
  assert.doesNotMatch(
    source,
    /listListenPids\([^)]*\)[\s\S]{0,1200}killProcessGroupOwnedByStack\(/,
    'restart wrappers must never select a termination target from a listening port',
  );
});

for (const [ownerPid, successorOwnerPid] of [[999_999, 999_999], [null, null], [null, 999_999]]) {
test(`restart cleanup is fenced to the originally observed lifecycle (${ownerPid} -> ${successorOwnerPid})`, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'hstack-restart-successor-'));
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const observedRuntimeState = {
    version: 1,
    stackName: 'restart-successor-fence',
    ownerPid,
    startedAt: '2026-08-13T08:00:00.000Z',
    processes: {},
  };
  const successorRuntimeState = {
    ...observedRuntimeState,
    ownerPid: successorOwnerPid,
    startedAt: '2026-08-13T08:00:00.001Z',
    sentinel: 'successor-must-survive',
  };

  try {
    await mkdir(join(baseDir, 'cli'), { recursive: true });
    await writeFile(runtimeStatePath, `${JSON.stringify(successorRuntimeState)}\n`, 'utf8');

    const result = await stackEnvRunner.stopObservedStackForRestart({
      rootDir: baseDir,
      stackName: observedRuntimeState.stackName,
      baseDir,
      env: {
        HAPPIER_STACK_STACK: observedRuntimeState.stackName,
        HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'),
        HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      },
      incumbentRuntimeState: observedRuntimeState,
    });

    assert.deepEqual(result.stopAuthorization, {
      authorized: false,
      reason: ownerPid === successorOwnerPid ? 'successor_owner_incarnation' : 'successor_owner',
      expectedOwnerPid: observedRuntimeState.ownerPid,
      expectedOwnerStartedAt: observedRuntimeState.startedAt,
      currentOwnerPid: successorRuntimeState.ownerPid,
      currentOwnerStartedAt: ownerPid === successorOwnerPid ? successorRuntimeState.startedAt : null,
    });
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), successorRuntimeState);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
}

test('buildAlreadyRunningMobileMetroArgs preserves Expo Tailscale mode', () => {
  assert.equal(typeof stackEnvRunner.buildAlreadyRunningMobileMetroArgs, 'function');
  assert.deepEqual(
    stackEnvRunner.buildAlreadyRunningMobileMetroArgs(['--mobile', '--expo-tailscale']),
    ['--metro', '--expo-tailscale']
  );
});

test('inspectExistingStartLikeRuntime treats --expo-tailscale as a mobile request', async () => {
  const result = await stackEnvRunner.inspectExistingStartLikeRuntime({
    scriptPath: 'dev.mjs',
    args: ['--expo-tailscale'],
  });

  assert.equal(result.wantsMobile, true);
});
