import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { waitForOwnerDeathWatchdogQuiescence } from './testkit/core/owner_death_watchdog_fixture.mjs';
import { writeWorkspacePackageBuildOwnerStub } from './testkit/core/workspace_package_build_owner.mjs';
import { waitForTcpPortFree } from './utils/net/ports.mjs';

function stackPaths() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  return {
    repoRoot,
    runScript: join(packageRoot, 'scripts', 'run.mjs'),
  };
}

function runNode(args, { cwd, env, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawned = false;
    let timedOut = false;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.once('spawn', () => { spawned = true; });
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      rejectOnce(error);
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectOnce(new Error(
          `timed out after ${timeoutMs}ms (spawned=${spawned}, pid=${proc.pid ?? 'null'})\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
        ));
        return;
      }
      resolveOnce({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr });
    });
  });
}

async function createOwnershipBoundaryBin({ rootDir, pid, stackName, envPath }) {
  const binDir = join(rootDir, 'boundary-bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'lsof'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_LISTEN_PID"\n', 'utf-8');
  await writeFile(join(binDir, 'ps'), `#!/bin/sh
case "$*" in
  *"pgid="*) printf "%s\\n" "$FAKE_LISTEN_PID" ;;
  *"eww -p"*)
    printf "PID COMMAND\\n"
    printf "%s node HAPPIER_STACK_STACK=%s HAPPIER_STACK_ENV_FILE=%s HAPPIER_STACK_PROCESS_KIND=server\\n" \
      "$FAKE_LISTEN_PID" "$FAKE_STACK_NAME" "$FAKE_STACK_ENV_FILE"
    ;;
  *) exec /bin/ps "$@" ;;
esac
`, 'utf-8');
  await chmod(join(binDir, 'lsof'), 0o755);
  await chmod(join(binDir, 'ps'), 0o755);
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_LISTEN_PID: String(pid),
    FAKE_STACK_NAME: stackName,
    FAKE_STACK_ENV_FILE: envPath,
  };
}

async function stopDetachedTestServer(server) {
  const child = server?.child;
  if (!child?.pid) return;
  child.stdout?.destroy();
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exit = new Promise((resolve) => child.once('exit', () => {
    exited = true;
    resolve();
  }));
  if (!exited) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
  if (!exited) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
  assert.equal(exited, true, `fixture process ${child.pid} did not exit during cleanup`);
  assert.equal(child.stdout?.destroyed, true, `fixture stdout for ${child.pid} remained active after cleanup`);
}

async function createFakeMonorepo(rootDir) {
  await mkdir(join(rootDir, 'node_modules'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });

  await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'fake-happier-root', private: true }) + '\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fake-cli', private: true }) + '\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
  await writeFile(
    join(rootDir, 'apps', 'server', 'package.json'),
    JSON.stringify({ name: 'fake-server', private: true, scripts: { start: 'node server.mjs' } }) + '\n',
    'utf-8',
  );
  await writeFile(join(rootDir, 'apps', 'cli', 'dist', 'index.mjs'), 'process.exit(0);\n', 'utf-8');
  await writeWorkspacePackageBuildOwnerStub(rootDir);
}

async function spawnStackOwnedHealthServer({ stackName, envPath, healthStatus = 200 }) {
  const child = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.statusCode = ${healthStatus};
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(String(addr.port) + '\\n');
    });
    setInterval(() => {}, 1e6);
  `], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  assert.ok(child.pid, 'expected stack-owned health server pid');
  child.unref();

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for health server port')), 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split(/\r?\n/).find(Boolean);
      const parsed = Number(line);
      if (Number.isInteger(parsed) && parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`health server exited before reporting port (code=${code}, signal=${signal})`));
    });
  });

  return { child, port };
}

for (const proxyProjection of ['current', 'missing']) {
  test(`hstack start preserves a proven proxy listener with ${proxyProjection} runtime proxy metadata`, async () => {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-proxy-runtime-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'proxy-runtime-start';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  let proxyServer = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
        `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
        '',
      ].join('\n'),
      'utf-8',
    );

    proxyServer = await spawnStackOwnedHealthServer({ stackName, envPath, healthStatus: 503 });
    const ownershipBoundaryEnv = await createOwnershipBoundaryBin({
      rootDir: tempRoot,
      pid: proxyServer.child.pid,
      stackName,
      envPath,
    });
    const port = proxyServer.port;
    const backendPort = port === 65535 ? port - 1 : port + 1;
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: { server: port, serverBackend: backendPort },
        processes: {
          proxyPid: proxyServer.child.pid,
          serverPid: 777777,
          serverBackendPid: 777777,
          serverDrainingPid: null,
        },
        ...(proxyProjection === 'current'
          ? { serverProxy: { enabled: true, mode: 'proxy', restartMode: 'exclusiveDb', fallbackReason: null } }
          : {}),
      }) + '\n',
      'utf-8',
    );

    const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...ownershipBoundaryEnv,
        CI: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SERVER_PORT: String(port),
      },
    });

    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /starting server|server started/i);

    const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(runtime.processes.proxyPid, proxyServer.child.pid);
    assert.notEqual(runtime.processes.serverPid, proxyServer.child.pid);
    assert.equal(runtime.processes.serverBackendPid, 777777);
    assert.equal(runtime.ports.serverBackend, backendPort);
    if (proxyProjection === 'current') {
      assert.deepEqual(runtime.serverProxy, {
        enabled: true,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
        fallbackReason: null,
      });
    } else {
      assert.equal(runtime.serverProxy, undefined);
    }
  } finally {
    await stopDetachedTestServer(proxyServer);
    await rm(tempRoot, { recursive: true, force: true });
  }
  });
}

test('hstack start uses one topology ownership observation for adoption and runtime reconciliation', async () => {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-direct-listener-scope-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'direct-runtime-start';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'bin');
  const countPath = join(tempRoot, 'lsof-count');
  let server = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'lsof'), '#!/bin/sh\nprintf x >> "$FAKE_LSOF_COUNT"\nprintf "%s\\n" "$FAKE_LISTEN_PID"\n', 'utf-8');
    await chmod(join(binDir, 'lsof'), 0o755);
    await writeFile(envPath, [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
      '',
    ].join('\n'), 'utf-8');
    server = await spawnStackOwnedHealthServer({ stackName, envPath });
    const ownershipBoundaryEnv = await createOwnershipBoundaryBin({
      rootDir: tempRoot,
      pid: server.child.pid,
      stackName,
      envPath,
    });
    await writeFile(runtimeStatePath, JSON.stringify({
      version: 1,
      stackName,
      script: 'run.mjs',
      ephemeral: true,
      ports: { server: server.port },
      processes: { serverPid: server.child.pid },
      serverProxy: { enabled: false, mode: 'direct' },
    }) + '\n', 'utf-8');

    const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...ownershipBoundaryEnv,
        PATH: `${binDir}:${ownershipBoundaryEnv.PATH}`,
        FAKE_LSOF_COUNT: countPath,
        FAKE_LISTEN_PID: String(server.child.pid),
        CI: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SERVER_PORT: String(server.port),
      },
    });

    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /start: already running/);
    assert.equal((await readFile(countPath, 'utf-8')).length, 1);
  } finally {
    await stopDetachedTestServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('already-running reconciliation fails closed on inconclusive listener ownership without side effects', async () => {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-ownership-unknown-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'main';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'timeout-bin');
  const countPath = join(tempRoot, 'lsof-count');
  const sideEffectPath = join(tempRoot, 'startup-side-effects');
  let server = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'lsof'),
      '#!/bin/sh\ncase "$*" in *"-iTCP:"*) printf "%s|%s\\n" "$$" "$*" >> "$FAKE_LSOF_COUNT"; exec /bin/sleep 20 ;; esac\nexit 1\n',
      'utf-8',
    );
    await writeFile(
      join(binDir, 'yarn'),
      '#!/bin/sh\nprintf "yarn:%s\\n" "$*" >> "$STARTUP_SIDE_EFFECT_PATH"\nexit 0\n',
      'utf-8',
    );
    await writeFile(
      join(binDir, 'docker'),
      '#!/bin/sh\nprintf "docker:%s\\n" "$*" >> "$STARTUP_SIDE_EFFECT_PATH"\nexit 0\n',
      'utf-8',
    );
    await Promise.all(['lsof', 'yarn', 'docker'].map((name) => chmod(join(binDir, name), 0o755)));
    await writeFile(envPath, [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
      '',
    ].join('\n'), 'utf-8');
    server = await spawnStackOwnedHealthServer({ stackName, envPath });
    const initialRuntime = {
      version: 1,
      stackName,
      script: 'run.mjs',
      ephemeral: true,
      ports: { server: server.port },
      processes: { serverPid: 777777 },
      serverProxy: { enabled: false, mode: 'direct' },
    };
    await writeFile(runtimeStatePath, JSON.stringify(initialRuntime) + '\n', 'utf-8');

    const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_LSOF_COUNT: countPath,
        STARTUP_SIDE_EFFECT_PATH: sideEffectPath,
        CI: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '0',
        HAPPIER_STACK_SERVER_PORT: String(server.port),
      },
    });

    assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /server startup topology is inconclusive/);
    assert.match(result.stderr, /ESERVERTOPOLOGYINCONCLUSIVE/);
    const listenerCalls = (await readFile(countPath, 'utf-8')).trim().split(/\n+/);
    assert.equal(listenerCalls.length, 1, `unexpected listener observations: ${listenerCalls.join(', ')}`);
    await assert.rejects(() => readFile(sideEffectPath, 'utf-8'), /ENOENT/);
    const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.deepEqual(runtime, initialRuntime);
    assert.equal(server.child.exitCode, null);
  } finally {
    await stopDetachedTestServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('hstack start claims ownership before spawn and publishes activation only after child-aware readiness', async () => {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-live-owner-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'live-owner-start';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const spawnMarkerPath = join(tempRoot, 'server-spawned');
  let portFixture = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    portFixture = await spawnStackOwnedHealthServer({ stackName, envPath });
    const port = portFixture.port;
    await stopDetachedTestServer(portFixture);
    portFixture = null;
    const releasedPort = await waitForTcpPortFree(port, { timeoutMs: 5_000 });
    assert.equal(releasedPort.status, 'free', `fixture port ${port} was not released: ${releasedPort.reason ?? releasedPort.status}`);
    await writeFile(
      join(fakeRepo, 'apps', 'server', 'server.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.SPAWN_MARKER_PATH, 'spawned');\nprocess.exit(9);\n`,
      'utf-8',
    );
    await writeFile(envPath, [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
      '',
    ].join('\n'), 'utf-8');
    await writeFile(runtimeStatePath, JSON.stringify({
      version: 1,
      stackName,
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: port },
      processes: {},
    }) + '\n', 'utf-8');

    const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '1',
        SPAWN_MARKER_PATH: spawnMarkerPath,
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SERVER_PORT: String(port),
      },
    });

    assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /already has a live lifecycle owner/);
    await assert.rejects(() => readFile(spawnMarkerPath, 'utf-8'), /ENOENT/);
  } finally {
    await stopDetachedTestServer(portFixture);
    await rm(tempRoot, { recursive: true, force: true });
  }

  await assertManagedBackendNotPublishedBeforeReadiness();
  await assertDefaultServerNotPublishedBeforeReadiness();
});

async function assertManagedBackendNotPublishedBeforeReadiness() {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-managed-readiness-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'managed-readiness-start';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'bin');
  let portFixture = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    portFixture = await spawnStackOwnedHealthServer({ stackName, envPath });
    const port = portFixture.port;
    await stopDetachedTestServer(portFixture);
    portFixture = null;
    const releasedPort = await waitForTcpPortFree(port, { timeoutMs: 5_000 });
    assert.equal(releasedPort.status, 'free', `fixture port ${port} was not released: ${releasedPort.reason ?? releasedPort.status}`);

    await writeFile(join(fakeRepo, 'apps', 'server', 'server.mjs'), 'setTimeout(() => process.exit(9), 50);\n', 'utf-8');
    await writeFile(join(binDir, 'docker'), `#!/bin/sh
case "$*" in
  *"redis-cli ping"*) printf "PONG\\n" ;;
  *) printf "ok\\n" ;;
esac
exit 0
`, 'utf-8');
    await writeFile(join(binDir, 'yarn'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf "4.0.0\\n"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "start" ]; then exec "$REAL_NODE" server.mjs; fi
exit 1
`, 'utf-8');
    await chmod(join(binDir, 'docker'), 0o755);
    await chmod(join(binDir, 'yarn'), 0o755);
    await writeFile(envPath, [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
      '',
    ].join('\n'), 'utf-8');

    const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        CI: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_DB_PROVIDER: 'postgres',
        HAPPIER_STACK_RUNTIME_DIR: join(tempRoot, 'runtime'),
        HAPPIER_STACK_LOG_TEE_DIR: join(tempRoot, 'logs'),
        HAPPIER_STACK_SERVER_PORT: String(port),
        HAPPIER_STACK_SERVER_BACKEND_PORT: String(port + 10),
        HAPPIER_STACK_PRISMA_MIGRATE: '0',
        HAPPIER_STACK_PG_PORT: String(port + 20),
        HAPPIER_STACK_REDIS_PORT: String(port + 21),
        HAPPIER_STACK_MINIO_PORT: String(port + 22),
        HAPPIER_STACK_MINIO_CONSOLE_PORT: String(port + 23),
        HAPPIER_STACK_DOCKER_AUTOSTART: '0',
      },
    });

    assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /exited before becoming ready/i);
    const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(runtime.processes?.happierServerBackendPid, undefined);
  } finally {
    await stopDetachedTestServer(portFixture);
    await waitForOwnerDeathWatchdogQuiescence({ storageDir, stackName });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertDefaultServerNotPublishedBeforeReadiness() {
  const { repoRoot, runScript } = stackPaths();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-default-readiness-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'default-readiness-start';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'bin');
  let portFixture = null;

  try {
    await createFakeMonorepo(fakeRepo);
    await mkdir(baseDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    portFixture = await spawnStackOwnedHealthServer({ stackName, envPath });
    const port = portFixture.port;
    await stopDetachedTestServer(portFixture);
    portFixture = null;
    const releasedPort = await waitForTcpPortFree(port, { timeoutMs: 5_000 });
    assert.equal(releasedPort.status, 'free', `fixture port ${port} was not released: ${releasedPort.reason ?? releasedPort.status}`);

    await writeFile(join(fakeRepo, 'apps', 'server', 'server.mjs'), 'setTimeout(() => process.exit(9), 50);\n', 'utf-8');
    await writeFile(join(binDir, 'yarn'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf "4.0.0\\n"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "start" ]; then exec "$REAL_NODE" server.mjs; fi
exit 1
`, 'utf-8');
    await chmod(join(binDir, 'yarn'), 0o755);
    await writeFile(envPath, [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
      '',
    ].join('\n'), 'utf-8');

    const result = await runNode([runScript, '--source', '--server=happier-server', '--no-daemon', '--no-ui'], {
      cwd: repoRoot,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        CI: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_MANAGED_INFRA: '0',
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_STACK_RUNTIME_DIR: join(tempRoot, 'runtime'),
        HAPPIER_STACK_LOG_TEE_DIR: join(tempRoot, 'logs'),
        HAPPIER_STACK_SERVER_PORT: String(port),
      },
    });

    assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /exited before becoming ready/i);
    const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    assert.equal(runtime.processes?.serverPid, undefined);
  } finally {
    await stopDetachedTestServer(portFixture);
    await waitForOwnerDeathWatchdogQuiescence({ storageDir, stackName });
    await rm(tempRoot, { recursive: true, force: true });
  }
}
