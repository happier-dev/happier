import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(dirname(scriptsDir)));
const runScript = join(scriptsDir, 'run.mjs');
const devScript = join(scriptsDir, 'dev.mjs');

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function spawnForeignHealthServer({ stackName, envPath, healthStatus = 200 }) {
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
      res.end();
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
    const timer = setTimeout(() => reject(new Error('foreign server fixture timed out')), 2_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const value = Number(output.split(/\r?\n/).find(Boolean));
      if (Number.isInteger(value) && value > 0) {
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
  return { child, port };
}

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

test('run proves a projected proxy PID when proxy metadata is missing and never publishes it as serverPid', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-run-topology-gate-'));
  const fakeRepo = join(tempRoot, 'repo');
  const storageDir = join(tempRoot, 'storage');
  const stackName = 'topology-gate';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const foreignEnvPath = join(tempRoot, 'foreign.env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const binDir = join(tempRoot, 'bin');
  const sideEffectMarker = join(tempRoot, 'side-effect');
  let server = null;

  t.after(async () => {
    await stopProcess(server?.child);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(join(fakeRepo, 'apps', 'server'), { recursive: true });
  await mkdir(join(fakeRepo, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(fakeRepo, 'apps', 'ui'), { recursive: true });
  await mkdir(baseDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(fakeRepo, 'package.json'), JSON.stringify({ name: 'fake-root', private: true }) + '\n');
  await writeFile(join(fakeRepo, 'apps', 'server', 'package.json'), JSON.stringify({
    name: 'fake-server', private: true, scripts: { start: 'node server.mjs' },
  }) + '\n');
  await writeFile(join(fakeRepo, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fake-cli', private: true }) + '\n');
  await writeFile(join(fakeRepo, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n');
  await writeFile(join(fakeRepo, 'apps', 'cli', 'dist', 'index.mjs'), 'process.exit(0);\n');
  await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`);
  await writeFile(foreignEnvPath, 'HAPPIER_STACK_STACK=foreign-stack\n');

  server = await spawnForeignHealthServer({ stackName, envPath, healthStatus: 503 });
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
  await writeFile(join(binDir, 'yarn'), '#!/bin/sh\nprintf "yarn:%s\\n" "$*" >> "$SIDE_EFFECT_MARKER"\ncase "$*" in *install*) exit 0 ;; *) exit 1 ;; esac\n');
  await writeFile(join(binDir, 'docker'), '#!/bin/sh\nprintf "docker:%s\\n" "$*" >> "$SIDE_EFFECT_MARKER"\nexit 0\n');
  await Promise.all(['lsof', 'ps', 'yarn', 'docker'].map((name) => chmod(join(binDir, name), 0o755)));
  await writeFile(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName,
    ownerPid: null,
    ports: { server: server.port },
    processes: { proxyPid: server.child.pid, serverPid: 777777, serverBackendPid: 777777 },
  }) + '\n');

  const result = await runNode([runScript, '--source', '--no-daemon', '--no-ui'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SIDE_EFFECT_MARKER: sideEffectMarker,
      FAKE_LISTEN_PID: String(server.child.pid),
      FAKE_STACK_NAME: stackName,
      FAKE_STACK_ENV_FILE: envPath,
      FOREIGN_ENV_FILE: foreignEnvPath,
      CI: '1',
      HAPPIER_STACK_RUNTIME_MODE: 'source',
      HAPPIER_STACK_REPO_DIR: fakeRepo,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '0',
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
      HAPPIER_STACK_SERVER_PORT: String(server.port),
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_DOCKER_AUTOSTART: '0',
      HAPPIER_STACK_SERVE_UI: '0',
    },
  });

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /already running/i);
  const finalRuntime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(finalRuntime.processes.proxyPid, server.child.pid);
  assert.notEqual(finalRuntime.processes.serverPid, server.child.pid);
  const devResult = await runNode([devScript, '--no-daemon', '--no-mobile'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SIDE_EFFECT_MARKER: sideEffectMarker,
      FAKE_LISTEN_PID: String(server.child.pid), FAKE_STACK_NAME: stackName, FAKE_STACK_ENV_FILE: envPath,
      CI: '1', HAPPIER_STACK_REPO_DIR: fakeRepo, HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath, HAPPIER_STACK_SERVER_PORT: String(server.port),
      HAPPIER_STACK_PRISMA_MIGRATE: '0', HAPPIER_STACK_DOCKER_AUTOSTART: '0', HAPPIER_STACK_SERVE_UI: '0',
    },
  });
  assert.notEqual(devResult.code, 0, 'the fake UI launcher should terminate the public dev fixture');
  const afterDevRuntime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(afterDevRuntime.processes.proxyPid, server.child.pid);
  assert.notEqual(afterDevRuntime.processes.serverPid, server.child.pid);
  const sideEffects = await readFile(sideEffectMarker, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  assert.match(`${devResult.stdout}\n${devResult.stderr}`, /expo|ui|package|workspace/i);
  assert.doesNotMatch(sideEffects, /prisma|migrat|happier-server(?:-light)?/i);
  await assert.rejects(() => readFile(join(fakeRepo, 'yarn.lock'), 'utf8'), /ENOENT/);
});
