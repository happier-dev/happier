import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';

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
