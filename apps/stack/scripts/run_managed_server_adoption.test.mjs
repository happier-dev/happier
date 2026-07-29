import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptsDir);
const repoRoot = dirname(dirname(packageRoot));
const runScript = join(packageRoot, 'scripts', 'run.mjs');

async function createFakeMonorepo(rootDir) {
  await mkdir(join(rootDir, 'node_modules'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'fake-root', private: true }) + '\n');
  await writeFile(join(rootDir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fake-cli', private: true }) + '\n');
  await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n');
  await writeFile(join(rootDir, 'apps', 'server', 'package.json'), JSON.stringify({
    name: 'fake-server',
    private: true,
    scripts: { start: 'node server.mjs' },
  }) + '\n');
  await writeFile(join(rootDir, 'apps', 'cli', 'dist', 'index.mjs'), 'process.exit(0);\n');
}

async function spawnStackOwnedHealthServer({ stackName, envPath }) {
  const child = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
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
  child.unref();
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for fixture server')), 2_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const parsed = Number(output.split(/\r?\n/).find(Boolean));
      if (Number.isInteger(parsed) && parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited before readiness (code=${code})`));
    });
  });
  return { child, port };
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitForOutput(getOutput, pattern, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = getOutput();
    if (pattern.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${pattern}:\n${getOutput()}`);
}

function runNode(args, { cwd, env, timeoutMs = 8_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

test('healthy managed server with a missing daemon is adopted without spawning a duplicate backend or gateway', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-run-managed-adoption-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'managed-adoption';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'bin');
  const spawnMarkerPath = join(tempRoot, 'managed-server-spawned');
  let server = null;
  let runner = null;

  t.after(async () => {
    await stopProcess(runner);
    await stopProcess(server?.child);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await createFakeMonorepo(fakeRepo);
  await mkdir(baseDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(envPath, [
    `HAPPIER_STACK_STACK=${stackName}`,
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
    'HAPPIER_STACK_SERVICE_MODE=1',
    'HAPPIER_STACK_AUTH_FLOW=1',
    `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
    `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
    '',
  ].join('\n'));

  server = await spawnStackOwnedHealthServer({ stackName, envPath });
  await writeFile(join(binDir, 'lsof'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_LISTEN_PID"\n');
  await writeFile(join(binDir, 'ps'), `#!/bin/sh
case "$*" in
  *"pgid="*) printf "%s\\n" "$FAKE_LISTEN_PID" ;;
  *"eww -p"*)
    printf "PID COMMAND\\n"
    printf "%s node HAPPIER_STACK_STACK=%s HAPPIER_STACK_ENV_FILE=%s HAPPIER_STACK_PROCESS_KIND=server\\n" "$FAKE_LISTEN_PID" "$FAKE_STACK_NAME" "$FAKE_STACK_ENV_FILE"
    ;;
  *) exec /bin/ps "$@" ;;
esac
`);
  await writeFile(join(binDir, 'docker'), '#!/bin/sh\ncase "$*" in *"redis-cli ping"*) printf "PONG\\n" ;; *) printf "ok\\n" ;; esac\n');
  await writeFile(join(binDir, 'yarn'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf "4.0.0\\n"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "start" ]; then
  printf "spawned\\n" >> "$SPAWN_MARKER_PATH"
  exec "$REAL_NODE" -e 'setInterval(() => {}, 1000000)'
fi
exit 0
`);
  await Promise.all(['lsof', 'ps', 'docker', 'yarn'].map((name) => chmod(join(binDir, name), 0o755)));
  await writeFile(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName,
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: null,
    ports: { server: server.port },
    processes: { serverPid: server.child.pid },
    serverProxy: { enabled: false, mode: 'managed-gateway' },
  }) + '\n');

  runner = spawn(process.execPath, [runScript, '--source', '--no-ui'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      SPAWN_MARKER_PATH: spawnMarkerPath,
      FAKE_LISTEN_PID: String(server.child.pid),
      FAKE_STACK_NAME: stackName,
      FAKE_STACK_ENV_FILE: envPath,
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
      HAPPIER_STACK_SERVER_PORT: String(server.port),
      HAPPIER_STACK_SERVER_BACKEND_PORT: String(server.port + 10),
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_SERVICE_MODE: '1',
      HAPPIER_STACK_AUTH_FLOW: '1',
      HAPPIER_STACK_DOCKER_AUTOSTART: '0',
      HAPPIER_STACK_SERVE_UI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  runner.stdout.setEncoding('utf8');
  runner.stderr.setEncoding('utf8');
  runner.stdout.on('data', (chunk) => { output += String(chunk); });
  runner.stderr.on('data', (chunk) => { output += String(chunk); });

  await waitForOutput(() => output, /auth flow: skipping daemon start until credentials exist/);
  await assert.rejects(() => readFile(spawnMarkerPath, 'utf8'), /ENOENT/);
  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(runtime.processes.serverPid, server.child.pid);
});

test('managed backend activation waits for child-bound readiness before publication', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-run-managed-readiness-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'managed-readiness';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'bin');
  let portFixture = null;

  t.after(async () => {
    await stopProcess(portFixture?.child);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await createFakeMonorepo(fakeRepo);
  await mkdir(baseDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  portFixture = await spawnStackOwnedHealthServer({ stackName, envPath });
  const port = portFixture.port;
  await stopProcess(portFixture.child);
  portFixture = null;
  await writeFile(join(fakeRepo, 'apps', 'server', 'server.mjs'), 'setTimeout(() => process.exit(9), 50);\n');
  await writeFile(join(binDir, 'docker'), '#!/bin/sh\ncase "$*" in *"redis-cli ping"*) printf "PONG\\n" ;; *) printf "ok\\n" ;; esac\n');
  await writeFile(join(binDir, 'yarn'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf "4.0.0\\n"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "start" ]; then exec "$REAL_NODE" server.mjs; fi
exit 0
`);
  await Promise.all(['docker', 'yarn'].map((name) => chmod(join(binDir, name), 0o755)));
  await writeFile(envPath, [
    `HAPPIER_STACK_STACK=${stackName}`,
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
    `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
    `HAPPIER_STACK_REPO_DIR=${fakeRepo}`,
    '',
  ].join('\n'));

  const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
    cwd: repoRoot,
    timeoutMs: 8_000,
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
      HAPPIER_STACK_SERVER_PORT: String(port),
      HAPPIER_STACK_SERVER_BACKEND_PORT: String(port + 10),
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_RUNTIME_DIR: join(tempRoot, 'runtime'),
      HAPPIER_STACK_LOG_TEE_DIR: join(tempRoot, 'logs'),
      HAPPIER_STACK_PG_PORT: String(port + 20),
      HAPPIER_STACK_REDIS_PORT: String(port + 21),
      HAPPIER_STACK_MINIO_PORT: String(port + 22),
      HAPPIER_STACK_MINIO_CONSOLE_PORT: String(port + 23),
      HAPPIER_STACK_DOCKER_AUTOSTART: '0',
      HAPPIER_STACK_SERVE_UI: '0',
    },
  });

  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /exited before becoming ready/i);
  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(runtime.processes?.happierServerBackendPid, undefined);
});
