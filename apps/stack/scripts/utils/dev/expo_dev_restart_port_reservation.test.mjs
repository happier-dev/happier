import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { ensureDevExpoServer, resolveMetroConfigFingerprint } from './expo_dev.mjs';
import { withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { getExpoStatePaths, looksLikeExpoMetro, writePidState } from '../expo/expo.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { once } from 'node:events';
import { delimiter } from 'node:path';

function listenEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('failed to resolve ephemeral port')));
        return;
      }
      const port = Number(addr.port);
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

test('recorded Expo ownership survives a self-restart and replaces the current child on its stable pin', { timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-recorded-owner-' });
  const uiDir = fixture.path('ui');
  const children = [];
  let owner, replacement, stopping = false;
  t.after(async () => {
    stopping = true;
    await owner?.close?.();
    await replacement?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGTERM');
    await Promise.all(children.map(child => child.completion));
  });
  await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"recorded-expo-owner"}');
  const listenerPidPath = fixture.path('listener.pid');
  const executable = join(uiDir, 'node_modules/.bin/expo');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const server = require('node:http').createServer((req, res) => res.end('packager-status:running'));
server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1',
  () => fs.writeFileSync(${JSON.stringify(listenerPidPath)}, String(process.pid)));
process.on('SIGTERM', () => {
  fs.rmSync(${JSON.stringify(listenerPidPath)}, { force: true });
  server.close(() => process.exit(0));
});
`);
  await chmod(executable, 0o755);
  const port = await listenEphemeralPort();
  // Model an OS socket table that cannot expose listener PIDs. Replacement
  // must retire the recorded child before attempting admission, not bypass it.
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'ss', content: `#!${process.execPath}
const fs = require('node:fs');
try {
  process.kill(Number(fs.readFileSync(${JSON.stringify(listenerPidPath)}, 'utf8')), 0);
  console.log('LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*');
} catch {}
` });
  const envPath = fixture.path('stack.env');
  await writeFile(envPath, `HAPPIER_STACK_EXPO_DEV_PORT=${port}\n`);
  const baseEnv = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
    PATH: [binDir, process.env.PATH].join(delimiter),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_EXPO_DEV_PORT: String(port),
    HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable', HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
    HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
    // A stack command can be invoked from a coding session. The new child is infrastructure.
    HAPPIER_STACK_PROCESS_KIND: 'session', HAPPIER_STACK_STACK: 'inherited-session-stack',
    HAPPIER_STACK_ENV_FILE: fixture.path('inherited.env') };
  const options = { startUi: true, uiDir, autostart: { baseDir: fixture.root }, baseEnv,
    stackMode: true, stackName: 'recorded-owner', envPath, children, quiet: true,
    runtimeStatePath: fixture.path('runtime.json'), isShuttingDown: () => stopping,
    spawnOptions: { silent: true } };
  owner = await ensureDevExpoServer(options);
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, 'fixture did not reach its process state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitFor(() => looksLikeExpoMetro({ port, statusOnly: true }));
  await killProcessTree(owner.proc, 'SIGTERM');
  await waitFor(() => children.length === 2 && looksLikeExpoMetro({ port, statusOnly: true }));
  const statePath = getExpoStatePaths({ baseDir: fixture.root, kind: 'expo-dev', projectDir: uiDir }).statePath;
  await waitFor(async () => JSON.parse(await readFile(statePath, 'utf8')).pid === children[1].pid);
  const recorded = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(recorded.pid, children[1].pid);
  assert.ok(recorded.processInstanceFingerprint);
  await owner.close();
  replacement = await ensureDevExpoServer({ ...options, restart: true,
    baseEnv: { ...baseEnv, HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0' } });
  await waitFor(() => looksLikeExpoMetro({ port, statusOnly: true }));
  assert.equal(replacement.port, port);
  assert.equal(children.length, 3, 'one self-restart and one requested replacement');
  assert.notEqual(children[1].exitCode ?? children[1].signalCode, null, 'replace the recorded successor, not the original pid');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pid, replacement.pid);
  assert.equal(await readFile(envPath, 'utf8'), `HAPPIER_STACK_EXPO_DEV_PORT=${port}\n`);
});

function killProcessTreeByPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return;
  try {
    process.kill(-n, 'SIGKILL');
  } catch {
    try {
      process.kill(n, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

function isPidAliveForTest(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExitForTest(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAliveForTest(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAliveForTest(pid);
}

function listenMetroStatusServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
            'Content-Type: text/plain\r\n' +
            'Content-Length: 23\r\n' +
            '\r\n' +
            'packager-status:running'
        );
        socket.end();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('failed to resolve metro status server port')));
        return;
      }
      resolve({ server, port: Number(addr.port) });
    });
  });
}

async function spawnOwnedMetroLikeExpoProcess({ port, projectDir, expoHomeDir, stackName = '', envPath = '', cliHomeDir = '' }) {
  const script = [
    "const net = require('net');",
    'const port = Number(process.env.TEST_PORT);',
    'const projectDir = process.argv[2] || "";',
    'const server = net.createServer((socket) => {',
    "  socket.once('data', () => {",
    '    socket.write(',
    "      'HTTP/1.1 200 OK\\r\\n' +",
    "      'Content-Type: text/plain\\r\\n' +",
    "      'Content-Length: 23\\r\\n' +",
    "      '\\r\\n' +",
    "      'packager-status:running'",
    '    );',
    '    socket.end();',
    '  });',
    '});',
    "server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ port, pid: process.pid, projectDir })));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const child = spawnDetachedTestProcess(process.execPath, ['-e', script, projectDir], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      TEST_PORT: String(port),
      __UNSAFE_EXPO_HOME_DIRECTORY: expoHomeDir,
      // The test runner may itself be a session process; this child models stack-owned Expo.
      HAPPIER_STACK_PROCESS_KIND: 'expo',
      ...(stackName ? { HAPPIER_STACK_STACK: stackName } : {}),
      ...(envPath ? { HAPPIER_STACK_ENV_FILE: envPath } : {}),
      ...(cliHomeDir ? { HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir } : {}),
    },
  });
  await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf('\n');
      if (index >= 0) resolve(buffer.slice(0, index));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`[test] owned Metro-like Expo exited before listening (code=${code ?? 'unknown'})`)));
  });
  return child;
}

test('disabled Expo recovery visibly settles inconclusive reload admission without another port probe',
  { timeout: 10000, skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-expo-terminal-reload-' });
    const children = [];
    t.after(async () => { for (const child of children) await killProcessTree(child, 'SIGTERM'); });
    const uiDir = fixture.path('ui');
    await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), '{"name":"terminal-expo-reload"}');
    await writeFile(join(uiDir, 'node_modules/.bin/expo'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    await chmod(join(uiDir, 'node_modules/.bin/expo'), 0o755);
    const { server, port } = await listenMetroStatusServer();
    t.after(async () => await new Promise(resolve => server.close(resolve)));
    const probes = fixture.path('probes');
    const { binDir } = writeFakeBin({ root: fixture.root, name: 'ss', content: `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
console.log('LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*');
` });
    let output = '';
    t.mock.method(process.stderr, 'write', chunk => { output += String(chunk); return true; });
    await assert.rejects(ensureDevExpoServer({ startUi: true, uiDir,
      autostart: { baseDir: fixture.root }, children, stackMode: true, stackName: 'terminal-owner',
      envPath: '', restart: true,
      baseEnv: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
        PATH: [binDir, process.env.PATH].join(delimiter), HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_SUPERVISE_RESTARTS: '0', HAPPIER_STACK_EXPO_DEV_PORT: String(port),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable' },
    }), error => error.code === 'EEXPOPORTINCONCLUSIVE'
      && error.observation.reason === 'listener-process-identity-unavailable');
    assert.match(output, /EEXPOPORTINCONCLUSIVE/);
    assert.match(output, /supervision_disabled/);
    assert.equal(children.length, 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await readFile(probes, 'utf8')).trim().split('\n').length, 1,
      'a terminal identity failure cannot poll the occupied stable pin');
  });

test('ensureDevExpoServer does not reserve prior metro port when restart cannot kill previous pid but the port is free', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-reserve-port-'));
  const children = [];
  let foreignPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "setInterval(() => {}, 1000);",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const foreign = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
      stdio: 'ignore',
    });
    foreignPid = foreign.pid;

    const priorPort = await listenEphemeralPort();
    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    await writePidState(paths.statePath, {
      pid: foreignPid,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
    });

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: true,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'dev2',
      envPath: join(tmp, 'stack.env'),
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, priorPort);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(foreignPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer restarts when running Expo state targets a different API server URL', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-restart-api-url-'));
  const children = [];
  let metro = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "setInterval(() => {}, 1000);",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const status = await listenMetroStatusServer();
    metro = status.server;
    const priorPort = status.port;

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    await writePidState(paths.statePath, {
      pid: 999999,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://localhost:3012',
    });

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
      },
      apiServerUrl: 'http://localhost:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-1',
      envPath: join(tmp, 'stack.env'),
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.notEqual(result.port, priorPort);

    const nextState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(nextState.apiServerUrl, 'http://localhost:3014');
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await new Promise((resolve) => metro?.close(() => resolve())).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer restarts mobile dev-client when running Expo state targets a different API server URL', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-restart-mobile-api-url-'));
  const children = [];
  let previousExpoPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "setInterval(() => {}, 1000);",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    const priorPort = await listenEphemeralPort();
    const stackName = 'qa-agent-mobile-api-url';
    const envPath = join(tmp, 'stack.env');
    const previousExpo = await spawnOwnedMetroLikeExpoProcess({
      port: priorPort,
      projectDir,
      expoHomeDir: paths.expoHomeDir,
      stackName,
      envPath,
    });
    previousExpoPid = previousExpo.pid;
    await writePidState(paths.statePath, {
      pid: previousExpoPid,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: false,
      devClientEnabled: true,
      host: 'lan',
      apiServerUrl: 'http://192.168.1.20:3012',
    });

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
        HAPPIER_STACK_MOBILE_SCHEME: 'happier-dev',
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
      },
      apiServerUrl: 'http://192.168.1.20:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);

    const nextState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(nextState.apiServerUrl, 'http://192.168.1.20:3014');
    assert.equal(nextState.devClientEnabled, true);
    assert.equal(await waitForPidExitForTest(previousExpoPid), true, 'expected automatic API mismatch replacement to stop prior stack-owned Expo process');
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(previousExpoPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer restarts a running Expo process whose state does not prove the current Metro config', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-restart-metro-config-'));
  const children = [];
  let previousExpoPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = { watchFolders: [] };\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "setInterval(() => {}, 1000);",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    const priorPort = await listenEphemeralPort();
    const stackName = 'qa-agent-metro-config';
    const envPath = join(tmp, 'stack.env');
    const previousExpo = await spawnOwnedMetroLikeExpoProcess({
      port: priorPort,
      projectDir,
      expoHomeDir: paths.expoHomeDir,
      stackName,
      envPath,
    });
    previousExpoPid = previousExpo.pid;
    await writePidState(paths.statePath, {
      pid: previousExpoPid,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: false,
      devClientEnabled: true,
      host: 'lan',
      apiServerUrl: 'http://192.168.1.20:3014',
    });

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
        HAPPIER_STACK_MOBILE_SCHEME: 'happier-dev',
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
      },
      apiServerUrl: 'http://192.168.1.20:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(await waitForPidExitForTest(previousExpoPid), true, 'expected stale-config Expo process to stop');

    const nextState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.match(nextState.metroConfigFingerprint, /^sha256:[a-f0-9]{64}$/);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(previousExpoPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer adopts a running Expo process that loaded the current Metro config', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-adopt-metro-config-'));
  const children = [];
  let previousExpoPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    const metroConfig = 'module.exports = { watchFolders: [] };\n';
    await mkdir(uiDir, { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(join(uiDir, 'metro.config.js'), metroConfig, 'utf-8');

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    const priorPort = await listenEphemeralPort();
    const stackName = 'qa-agent-current-metro-config';
    const envPath = join(tmp, 'stack.env');
    const baseEnv = {
      ...process.env,
      HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
      HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
      HAPPIER_STACK_MOBILE_SCHEME: 'happier-dev',
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
    };
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await withDependencyRefresh({ installDir: uiDir,
      // This fixture publishes its own empty dependency tree. Runner opt-outs
      // must not suppress that producer before the Metro fingerprint is saved.
      env: { ...baseEnv, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } }, async () => {});
    const previousExpo = await spawnOwnedMetroLikeExpoProcess({
      port: priorPort,
      projectDir,
      expoHomeDir: paths.expoHomeDir,
      stackName,
      envPath,
    });
    previousExpoPid = previousExpo.pid;
    await writePidState(paths.statePath, {
      pid: previousExpoPid,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: false,
      devClientEnabled: true,
      host: 'lan',
      apiServerUrl: 'http://192.168.1.20:3014',
      metroConfigFingerprint: await resolveMetroConfigFingerprint({ projectDir, env: baseEnv }),
    });

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv,
      apiServerUrl: 'http://192.168.1.20:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
      prepareExpoWorkspace: async () => {},
      hasUsableWorkspaceLastGreen: async () => true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.pid, previousExpoPid);
    assert.equal(isPidAliveForTest(previousExpoPid), true);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(previousExpoPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('initial Expo replacement preserves producer identity and refuses a same-pid successor', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-replacement-successor-'));
  const children = [];
  let previousExpoPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, ['#!/usr/bin/env node', "setInterval(() => {}, 1000);"].join('\n') + '\n', 'utf-8');
    await chmod(expoBin, 0o755);

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    const priorPort = await listenEphemeralPort();
    const stackName = 'qa-expo-replacement-successor';
    const envPath = join(tmp, 'stack.env');
    const previousExpo = await spawnOwnedMetroLikeExpoProcess({
      port: priorPort,
      projectDir,
      expoHomeDir: paths.expoHomeDir,
      stackName,
      envPath,
    });
    previousExpoPid = previousExpo.pid;
    await writePidState(paths.statePath, {
      pid: previousExpoPid,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://127.0.0.1:3012',
    });
    const recordedState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    await writeFile(
      paths.statePath,
      JSON.stringify({
        ...recordedState,
        processInstanceFingerprint: 'darwin-ps:recorded-predecessor',
      }) + '\n',
      'utf-8',
    );

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
      },
      apiServerUrl: 'http://127.0.0.1:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.notEqual(result.port, priorPort);
    assert.equal(
      isPidAliveForTest(previousExpoPid),
      true,
      'the current same-pid occupant must not inherit predecessor cleanup authority',
    );
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(previousExpoPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer in stack mode does not adopt port-only fallback as already running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-port-fallback-stack-mode-'));
  const children = [];
  let metro = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "setInterval(() => {}, 1000);",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const status = await listenMetroStatusServer();
    metro = status.server;
    const priorPort = status.port;

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    await writePidState(paths.statePath, {
      pid: 999999,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://localhost:3014',
    });

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
      },
      apiServerUrl: 'http://localhost:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-4',
      envPath: join(tmp, 'stack.env'),
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.notEqual(result.port, priorPort);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await new Promise((resolve) => metro?.close(() => resolve())).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer fails closed in stable port mode when forced expo port is occupied (does not rewrite envPath)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-update-env-port-'));
  const children = [];
  let metro = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      ['#!/usr/bin/env node', "setInterval(() => {}, 1000);"].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const status = await listenMetroStatusServer();
    metro = status.server;
    const occupiedPort = status.port;

    const envPath = join(tmp, 'stack.env');
    await writeFile(envPath, `CUSTOM_KEY=1\nHAPPIER_STACK_EXPO_DEV_PORT=${occupiedPort}\n`, 'utf-8');

    await assert.rejects(
      () =>
        ensureDevExpoServer({
          startUi: true,
          startMobile: false,
          uiDir,
          autostart: { baseDir: tmp },
          baseEnv: {
            ...process.env,
            HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
            HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
            HAPPIER_STACK_EXPO_DEV_PORT: String(occupiedPort),
            HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
            HAPPIER_STACK_EXPO_DEV_PORT_BASE: '51000',
            HAPPIER_STACK_EXPO_DEV_PORT_RANGE: '2000',
          },
          apiServerUrl: 'http://127.0.0.1:1',
          restart: false,
          stackMode: true,
          runtimeStatePath: null,
          stackName: 'qa-agent-update-env',
          envPath,
          children,
          quiet: true,
        }),
      /expo port/i
    );

    const updated = await readFile(envPath, 'utf-8');
    assert.match(updated, /\bCUSTOM_KEY=1\b/);
    assert.match(updated, new RegExp(`\\bHAPPIER_STACK_EXPO_DEV_PORT=${occupiedPort}\\b`));
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await new Promise((resolve) => metro?.close(() => resolve())).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer in stable port mode stops stack-owned leftover Expo processes holding the forced port (no bump)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-stable-stop-leftovers-'));
  const children = [];
  let holderPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, ['#!/usr/bin/env node', "setInterval(() => {}, 1000);"].join('\n') + '\n', 'utf-8');
    await chmod(expoBin, 0o755);

    const occupiedPort = await listenEphemeralPort();
    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });

    const stackName = 'qa-owned-expo-leftover';
    const cliHomeDir = join(tmp, 'cli');
    const envPath = join(tmp, 'stack.env');
    await mkdir(cliHomeDir, { recursive: true });

    // Spawn a process that (1) holds the port and (2) carries the same Expo isolation env marker,
    // so ensureDevExpoServer can identify and stop it without bumping the stable port.
    const holder = spawnDetachedTestProcess(
      process.execPath,
      [
        '-e',
        [
          "const net = require('net');",
          'const port = Number(process.env.TEST_PORT);',
          "const srv = net.createServer(() => {});",
          "srv.listen(port, '127.0.0.1');",
          "setInterval(() => {}, 1000);",
        ].join(''),
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          TEST_PORT: String(occupiedPort),
          __UNSAFE_EXPO_HOME_DIRECTORY: paths.expoHomeDir,
          HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
          HAPPIER_STACK_ENV_FILE: envPath,
          HAPPIER_STACK_PROCESS_KIND: 'expo',
        },
      }
    );
    holderPid = holder.pid;

    await writeFile(envPath, `HAPPIER_STACK_EXPO_DEV_PORT=${occupiedPort}\n`, 'utf-8');

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_EXPO_DEV_PORT: String(occupiedPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, occupiedPort);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(holderPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stable-port Expo cleanup refuses a same-pid successor recorded with predecessor identity', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-stable-successor-'));
  const children = [];
  let holderPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, ['#!/usr/bin/env node', "setInterval(() => {}, 1000);"].join('\n') + '\n', 'utf-8');
    await chmod(expoBin, 0o755);

    const occupiedPort = await listenEphemeralPort();
    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    const stackName = 'qa-expo-stable-successor';
    const cliHomeDir = join(tmp, 'cli');
    const envPath = join(tmp, 'stack.env');
    await mkdir(cliHomeDir, { recursive: true });
    const holder = await spawnOwnedMetroLikeExpoProcess({
      port: occupiedPort,
      projectDir,
      expoHomeDir: paths.expoHomeDir,
      stackName,
      envPath,
      cliHomeDir,
    });
    holderPid = holder.pid;
    await writePidState(paths.statePath, {
      pid: holderPid,
      port: occupiedPort,
      uiDir,
      projectDir: join(tmp, 'different-project'),
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://127.0.0.1:1',
    });
    const recordedState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    await writeFile(
      paths.statePath,
      JSON.stringify({
        ...recordedState,
        processInstanceFingerprint: 'darwin-ps:recorded-predecessor',
      }) + '\n',
      'utf-8',
    );
    await writeFile(envPath, `HAPPIER_STACK_EXPO_DEV_PORT=${occupiedPort}\n`, 'utf-8');

    await assert.rejects(
      () => ensureDevExpoServer({
        startUi: true,
        startMobile: false,
        uiDir,
        autostart: { baseDir: tmp },
        baseEnv: {
          ...process.env,
          HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
          HAPPIER_STACK_EXPO_DEV_PORT: String(occupiedPort),
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
          HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
          HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_ENV_FILE: envPath,
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        },
        apiServerUrl: 'http://127.0.0.1:1',
        restart: false,
        stackMode: true,
        runtimeStatePath: null,
        stackName,
        envPath,
        children,
        quiet: true,
      }),
      /expo port/i,
    );
    assert.equal(
      isPidAliveForTest(holderPid),
      true,
      'stable-port cleanup must not kill a same-pid successor',
    );
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(holderPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('dependency reload retries refused stale ownership and inconclusive identity until the pinned Expo port is free',
  { timeout: 15000, skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-expo-refused-reload-', registerCleanup: false });
    const uiDir = fixture.path('ui');
    const children = [];
    let holder, startup, result;
    let shuttingDown = false;
    t.after(async () => {
      shuttingDown = true;
      await killProcessTree(holder, 'SIGTERM');
      await startup?.catch(() => {});
      await result?.close?.();
      for (const child of children) await killProcessTree(child, 'SIGTERM');
      await Promise.all(children.map(child => child.completion));
      await fixture.cleanup();
    });
    const port = await listenEphemeralPort();
    const stackName = 'qa-expo-refused-reload';
    const envPath = fixture.path('stack.env');
    const paths = getExpoStatePaths({ baseDir: fixture.root, kind: 'expo-dev', projectDir: uiDir });
    await mkdir(join(uiDir, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), '{"name":"refused-reload-fixture"}');
    const executable = join(uiDir, 'node_modules/.bin/expo');
    await writeFile(executable, `#!${process.execPath}
require('node:http').createServer((req, res) => res.end('packager-status:running'))
  .listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
    await chmod(executable, 0o755);
    holder = await spawnOwnedMetroLikeExpoProcess({ port, projectDir: uiDir,
      expoHomeDir: paths.expoHomeDir, stackName, envPath });
    await writePidState(paths.statePath, { pid: holder.pid, port, uiDir, projectDir: uiDir,
      webEnabled: true, devClientEnabled: false, apiServerUrl: 'http://127.0.0.1:1' });
    const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
    await writeFile(paths.statePath, JSON.stringify({ ...state,
      processInstanceFingerprint: 'linux-proc:recorded-before-reboot' }));
    await writeFile(envPath, `HAPPIER_STACK_EXPO_DEV_PORT=${port}\n`);
    const observationRepaired = fixture.path('observation-repaired');
    // Substitute only the OS socket-discovery executable: its real parser,
    // ownership/fingerprint checks, port binding, retry owner and children run.
    const { binDir } = writeFakeBin({ root: fixture.root, name: 'ss', content: `#!${process.execPath}
if (!require('node:fs').existsSync(${JSON.stringify(observationRepaired)}))
  console.log('LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*');
` });
    let output = '', outcome = 'pending', startupError;
    t.mock.method(console, 'warn', line => { output += String(line); });
    t.mock.method(process.stderr, 'write', chunk => { output += String(chunk); return true; });
    const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      PATH: [binDir, process.env.PATH].join(delimiter),
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
      HAPPIER_STACK_EXPO_DEV_PORT: String(port), HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '100', HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '100' };
    startup = ensureDevExpoServer({ startUi: true, uiDir, autostart: { baseDir: fixture.root },
      baseEnv: env, apiServerUrl: 'http://127.0.0.1:1', restart: true, stackMode: true,
      stackName, envPath, children, isShuttingDown: () => shuttingDown, spawnOptions: { silent: true } });
    void startup.then(value => { result = value; outcome = 'started'; }, error => { startupError = error; outcome = 'failed'; });
    const waitFor = async predicate => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('refused-reload fixture did not reach its next lifecycle boundary');
    };
    await waitFor(() => outcome === 'failed' || output.includes('attempt 2'));
    if (startupError) {
      assert.equal(startupError.code, 'EEXPOPORTINCONCLUSIVE');
      assert.equal(startupError.observation.reason, 'listener-process-identity-unavailable');
    }
    assert.equal(outcome, 'pending', 'a refused dependency reload must retry without another input change');
    assert.match(output, /listener-process-identity-unavailable/);
    assert.equal(isPidAliveForTest(holder.pid), true, 'unverified incumbents must not be signalled');
    assert.equal(children.length, 0, 'no duplicate may bypass an inconclusive pinned port');
    const holderClosed = once(holder, 'close');
    await killProcessTree(holder, 'SIGTERM');
    await holderClosed;
    await writeFile(observationRepaired, 'available');
    result = await startup;
    assert.equal(result.port, port, 'the replacement must keep the configured pin');
    await waitFor(() => fetch(`http://127.0.0.1:${port}/status`).then(response => response.ok).catch(() => false));
    assert.equal(children.length, 1);
    assert.equal(output.split('dev Expo restarted (auto)').length - 1, 1);
    assert.equal(await readFile(envPath, 'utf8'), `HAPPIER_STACK_EXPO_DEV_PORT=${port}\n`);
  });
