import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runNodeCapture as runNode } from './testkit/core/run_node_capture.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(dirname(scriptsDir)));
const runScript = join(scriptsDir, 'run.mjs');
const devScript = join(scriptsDir, 'dev.mjs');
// docs/testing.md:214–218: cold preparation/launch failures recover through
// the existing Expo supervisor while the Stack remains running.
const retryingExpoFailure = /\[expo\] Expo startup failed \([\s\S]*?\); retrying in /;
const isolatedExpoFailure = /expo startup failed; keeping other components running/;

test('dev fails before daemon readiness when its requested server cannot start', { timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-server-failure-' });
  const fakeRepo = fixture.path('repo');
  for (const app of ['cli', 'ui']) {
    await mkdir(join(fakeRepo, 'apps', app), { recursive: true });
    await writeFile(join(fakeRepo, 'apps', app, 'package.json'), JSON.stringify({ name: `fixture-${app}` }));
  }
  await writeFile(join(fakeRepo, 'package.json'), '{"private":true}');
  await mkdir(join(fakeRepo, 'node_modules'), { recursive: true });
  await writeFile(join(fakeRepo, 'pnpm-lock.yaml'), '# fixture');
  await writeFile(join(fakeRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const fakePm = writeFakeBin({ root: fixture.root, name: 'pnpm', content: '#!/bin/sh\nexit 0\n' });
  const child = spawn(process.execPath, [devScript, '--no-ui', '--no-mobile', '--no-watch', '--no-dev-targets', '--no-browser'], {
    cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir: fakeRepo }),
      PATH: `${fakePm.binDir}:${process.env.PATH}`, CI: '1',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_RUNTIME_MODE: 'source',
      HAPPIER_STACK_REPO_DIR: fakeRepo, HAPPIER_STACK_STACK: 'server-start-failure',
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_RUNTIME_STATE_PATH: fixture.path('runtime.json'),
      HAPPIER_STACK_ENV_FILE: fixture.path('env'), HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
      HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_AUTH_FLOW: '0',
    },
  });
  t.after(() => stopProcess(child));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const result = await new Promise((resolve, reject) => {
    const onAbort = () => {
      t.diagnostic(`Requested server failure observed: ${/server startup failed/.test(output)}`);
      reject(new Error('Dev kept running after the requested server failed'));
    };
    t.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      t.signal.removeEventListener('abort', onAbort);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 1, output);
  assert.equal(result.signal, null, output);
  assert.match(output, /happier-server/);
  assert.doesNotMatch(output, /daemon is still starting|daemon startup failed/);
});

for (const failure of ['preflight', 'missing-directory']) {
test(`dev isolates a cold Expo ${failure} failure instead of terminating the disposable stack`, { timeout: 15000 }, async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-dev-component-failure-'));
  let child;
  t.after(async () => { await stopProcess(child); await rm(tempRoot, { recursive: true, force: true }); });
  const fakeRepo = join(tempRoot, 'repo');
  for (const app of ['cli', 'server', 'ui']) {
    if (app === 'ui' && failure === 'missing-directory') continue;
    await mkdir(join(fakeRepo, 'apps', app), { recursive: true });
    await writeFile(join(fakeRepo, 'apps', app, 'package.json'), JSON.stringify({ name: `fixture-${app}` }));
  }
  await writeFile(join(fakeRepo, 'package.json'), '{"private":true}');
  await mkdir(join(fakeRepo, 'node_modules'), { recursive: true });
  await writeFile(join(fakeRepo, 'pnpm-lock.yaml'), '# fixture');
  await writeFile(join(fakeRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const fakePm = writeFakeBin({ root: tempRoot, name: 'pnpm', content: '#!/bin/sh\nexit 0\n' });
  if (failure === 'preflight') {
    await mkdir(join(fakeRepo, 'apps/ui/scripts'));
    await writeFile(join(fakeRepo, 'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'), `
    export function resolveUiWorkspaceStartupOutputs() { return []; }
    export async function ensureUiWorkspacePackagesBuilt() {
      throw Object.assign(new Error('fixture preflight permission denied'), {code: 'EACCES'});
    }
  `);
  }
  child = spawn(process.execPath, [devScript, '--no-server', '--server-url=http://127.0.0.1:1',
    '--no-daemon', '--no-watch', '--no-dev-targets', '--no-browser'], {
    cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: tempRoot, repoDir: fakeRepo }),
      PATH: `${fakePm.binDir}:${process.env.PATH}`,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      CI: '1', HAPPIER_STACK_RUNTIME_MODE: 'source',
      HAPPIER_STACK_REPO_DIR: fakeRepo, HAPPIER_STACK_STACK: 'last-green-qa',
      HAPPIER_STACK_STORAGE_DIR: join(tempRoot, 'stacks'),
      HAPPIER_STACK_RUNTIME_STATE_PATH: join(tempRoot, 'runtime.json'),
      HAPPIER_STACK_ENV_FILE: join(tempRoot, 'env'),
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server', HAPPIER_STACK_AUTH_FLOW: '0',
      HAPPIER_STACK_EXPO_TAILSCALE: '0', HAPPIER_STACK_EXPO_SOURCE_STACK: '',
    },
  });
  const expectedFailure = failure === 'preflight' ? retryingExpoFailure : isolatedExpoFailure;
  const observed = await waitForExpoStartupFailure(child, t, expectedFailure);
  assert.match(observed.output, expectedFailure);
  assert.equal(child.exitCode, null, observed.output);
  assert.match(observed.output, failure === 'preflight' ? /fixture preflight permission denied/ : /happier-ui/);
});
}

function waitForExpoStartupFailure(child, t, expectedFailure) {
  const signal = t.signal;
  return new Promise((resolve, reject) => {
    let output = '';
    const finish = error => {
      signal.removeEventListener('abort', onAbort);
      child.stdout.off('data', receive);
      child.stderr.off('data', receive);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve({ output });
    };
    const onAbort = () => {
      t.diagnostic(`Dev output before cancellation:\n${output}`);
      finish(new Error(`Expo startup failure was not observed before test cancellation.\n${output}`,
        { cause: signal.reason }));
    };
    const receive = chunk => {
      output += chunk;
      if (expectedFailure.test(output)) finish();
    };
    const onExit = (code, exitSignal) => finish(new Error(
      `Dev exited before the expected Expo startup failure (code=${code}, signal=${exitSignal}).\n${output}`));
    const onError = error => finish(error);
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('exit', onExit);
    child.once('error', onError);
    if (signal.aborted) onAbort();
    else if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

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

// The run → dev journey measured 19.9s on AUTO/nl3 (cold Expo alone 10.1–11.6s).
// Allow 30s for the two-process fixture; missing outcomes abort its own children.
test('run proves a projected proxy PID when proxy metadata is missing and never publishes it as serverPid', { timeout: 30_000 }, async (t) => {
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
  let dev = null;

  t.after(async () => {
    await stopProcess(dev);
    await stopProcess(server?.child);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(join(fakeRepo, 'apps', 'server'), { recursive: true });
  await mkdir(join(fakeRepo, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(fakeRepo, 'apps', 'ui'), { recursive: true });
  await mkdir(baseDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(fakeRepo, 'package.json'), JSON.stringify({ name: 'fake-root', private: true }) + '\n');
  await writeFile(join(fakeRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
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
  await writeFile(join(binDir, 'pnpm'), '#!/bin/sh\nprintf "pnpm:%s\\n" "$*" >> "$SIDE_EFFECT_MARKER"\ncase "$*" in --version) printf "12.14.0\\n" ;; *install*) exit 0 ;; *) exit 1 ;; esac\n');
  await writeFile(join(binDir, 'docker'), '#!/bin/sh\nprintf "docker:%s\\n" "$*" >> "$SIDE_EFFECT_MARKER"\nexit 0\n');
  await Promise.all(['lsof', 'ps', 'pnpm', 'docker'].map((name) => chmod(join(binDir, name), 0o755)));
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
  dev = spawn(process.execPath, [devScript, '--no-daemon', '--no-mobile'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const devResult = await waitForExpoStartupFailure(dev, t, retryingExpoFailure);
  assert.match(devResult.output, retryingExpoFailure);
  assert.equal(dev.exitCode, null, devResult.output);
  const afterDevRuntime = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
  assert.equal(afterDevRuntime.processes.proxyPid, server.child.pid);
  assert.notEqual(afterDevRuntime.processes.serverPid, server.child.pid);
  const sideEffects = await readFile(sideEffectMarker, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
  assert.match(devResult.output, /expo|ui|package|workspace/i);
  assert.doesNotMatch(sideEffects, /prisma|migrat|happier-server(?:-light)?/i);
  await assert.rejects(() => readFile(join(fakeRepo, 'pnpm-lock.yaml'), 'utf8'), /ENOENT/);
  await stopProcess(dev);
});
