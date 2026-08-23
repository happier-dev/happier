import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { isPidAlive } from '../proc/pids.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { pickLanIpv4 } from '../net/lan_ip.mjs';

let listenerFixtureRoot = null;
let previousPath = null;

before(async () => {
  listenerFixtureRoot = await mkdtemp(join(tmpdir(), 'hstack-expo-listener-boundary-'));
  await mkdir(join(listenerFixtureRoot, 'listeners'), { recursive: true });
  const systemLsofPath = execFileSync('/bin/sh', ['-c', 'command -v lsof'], { encoding: 'utf-8' }).trim();
  assert.ok(systemLsofPath, 'lsof must be available for Expo listener-boundary tests');
  const { binDir } = writeFakeBin({
    root: listenerFixtureRoot,
    name: 'lsof',
    content: `#!/bin/sh
port=''
for arg in "$@"; do
  case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac
done
owner_file="${join(listenerFixtureRoot, 'listeners')}/$port"
if [ -n "$port" ] && [ -f "$owner_file" ]; then
  owner_pid="$(/bin/cat "$owner_file")"
  if [ "\${TEST_EXPO_LISTENER_MARKERS_ONLY:-0}" = "1" ]; then
    printf '%s\n' "$owner_pid"
    exit 0
  fi
  owner_state="$(/bin/ps -o stat= -p "$owner_pid" 2>/dev/null)"
  if [ -n "$owner_state" ] && ! printf '%s' "$owner_state" | /usr/bin/grep -q 'Z'; then
    printf '%s\n' "$owner_pid"
    exit 0
  fi
  /bin/rm -f "$owner_file"
  exit 1
fi
if [ "\${TEST_EXPO_LISTENER_MARKERS_ONLY:-0}" = "1" ]; then
  exit 1
fi
exec ${JSON.stringify(systemLsofPath)} "$@"
`,
  });
  const env = buildStackHarnessEnv({ baseEnv: process.env, binDirs: [binDir] });
  previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
});

after(async () => {
  if (previousPath == null) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (listenerFixtureRoot) await rm(listenerFixtureRoot, { recursive: true, force: true });
});

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

function buildExpoFixtureEnv(extraEnv = {}) {
  return buildStackFixtureEnv({
    baseEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
    stripStackEnv: true,
    extraEnv: {
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      TEST_EXPO_LISTENER_DIR: join(listenerFixtureRoot, 'listeners'),
      ...extraEnv,
    },
  });
}

function uniqueStackName(label) {
  return `${label}-${process.pid}`;
}

async function spawnReadyFixture(extraEnv = {}) {
  const child = spawnDetachedInlineNodeTestProcess(
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: buildExpoFixtureEnv({ HAPPIER_STACK_PROCESS_KIND: 'infra', ...extraEnv }),
    },
  );
  const ready = once(child.stdout, 'data');
  await once(child, 'spawn');
  await ready;
  return child;
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

async function waitForPidExit(pid, timeoutMs = 5000) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(n)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(n);
}

async function waitForChildExit(child, timeoutMs = 15000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function cleanupChildProcesses(children) {
  for (const child of children) killProcessTreeByPid(child?.pid);
  await Promise.all(children.map(async (child) => {
    await waitForChildExit(child, 5000);
    child?.stdout?.destroy?.();
    child?.stderr?.destroy?.();
  }));
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
    server.listen(0, undefined, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('failed to resolve metro status server port')));
        return;
      }
      resolve({ server, port: Number(addr.port) });
    });
  });
}

test('ensureDevExpoServer reselects after a foreign Metro collision and publishes only the certified child', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-reserve-port-'));
  const children = [];
  let foreign = null;
  let responderPid = null;
  let occupiedPortServer = null;
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
        "const fs = require('node:fs');",
        "const countPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;",
        "fs.writeFileSync(countPath, String(current));",
        "const { spawn } = require('node:child_process');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "if (current === 1) {",
        "  const source = `const http=require('node:http');const fs=require('node:fs');http.createServer((req,res)=>res.end(req.url==='/status'?'packager-status:running':'foreign')).listen(${port},'127.0.0.1',()=>{fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR+'/${port}',String(process.pid));console.log('ready')});setInterval(()=>{},1000);`;",
        "  const responder = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });",
        "  responder.stdout.once('data', () => console.log('foreign-responder:' + responder.pid));",
        "  setInterval(() => {}, 1000);",
        "} else {",
        "  const http = require('node:http');",
        "  http.createServer((req,res)=>res.end(req.url === '/status' ? 'packager-status:running' : 'owned')).listen(port, '127.0.0.1', () => fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/' + port, String(process.pid)));",
        "}",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    foreign = await spawnReadyFixture();
    const foreignPid = foreign.pid;

    const priorPort = await listenEphemeralPort();
    occupiedPortServer = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      occupiedPortServer.once('error', reject);
      occupiedPortServer.listen(priorPort, '127.0.0.1', resolve);
    });
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
        baseEnv: buildExpoFixtureEnv({
          HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
          HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS: '15000',
          HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS: '25',
          FAKE_EXPO_RUN_COUNT_PATH: join(tmp, 'expo-runs.txt'),
        }),
        apiServerUrl: 'http://127.0.0.1:1',
        restart: true,
        stackMode: true,
        runtimeStatePath: null,
        stackName: uniqueStackName('dev2'),
        envPath: join(tmp, 'stack.env'),
        children,
        spawnOptions: {
          onLine: ({ line }) => {
            const match = String(line).match(/^foreign-responder:(\d+)$/);
            if (match) responderPid = Number(match[1]);
          },
        },
        quiet: true,
      });

    assert.equal(result.ok, true);
    assert.ok(children.length >= 2);
    assert.equal(await waitForPidExit(children[0].pid), true);
    assert.equal(result.pid, children.at(-1).pid);
    assert.notEqual(result.port, priorPort);
    const concurrentPortDir = String(process.env.TEST_CONCURRENT_EXPO_PORT_DIR ?? '').trim();
    if (concurrentPortDir) {
      const expected = Number(process.env.TEST_CONCURRENT_EXPO_PORT_COUNT ?? 10);
      await mkdir(concurrentPortDir, { recursive: true });
      await writeFile(join(concurrentPortDir, `${process.pid}.port`), String(result.port), 'utf-8');
      const deadline = Date.now() + 30_000;
      let files = [];
      while (Date.now() < deadline) {
        files = (await readdir(concurrentPortDir)).filter((file) => file.endsWith('.port'));
        if (files.length >= expected) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(files.length, expected);
      const ports = await Promise.all(files.map((file) => readFile(join(concurrentPortDir, file), 'utf-8')));
      assert.equal(new Set(ports.map((port) => Number(port))).size, expected);
    }
    await assert.rejects(readFile(join(tmp, 'stack.env'), 'utf-8'), { code: 'ENOENT' });
  } finally {
    if (occupiedPortServer) {
      await new Promise((resolve) => occupiedPortServer.close(resolve));
    }
    await cleanupChildProcesses(children);
    await cleanupChildProcesses([foreign]);
    killProcessTreeByPid(responderPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer cleans a same-group descendant when the Expo wrapper exits before readiness', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-exit-cleanup-'));
  const children = [];
  let descendantPid = null;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(expoBin, [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log('descendant:' + descendant.pid);",
      "setTimeout(() => process.exit(1), 25);",
    ].join('\n') + '\n', 'utf-8');
    await chmod(expoBin, 0o755);
    await assert.rejects(() => ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildExpoFixtureEnv({
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
      }),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: uniqueStackName('exit-cleanup'),
      envPath: join(tmp, 'stack.env'),
      children,
      spawnOptions: {
        onLine: ({ line }) => {
          const match = String(line).match(/^descendant:(\d+)$/);
          if (match) descendantPid = Number(match[1]);
        },
      },
      quiet: true,
    }), /owner_process_exited/);
    assert.ok(descendantPid);
    assert.equal(await waitForPidExit(descendantPid), true);
  } finally {
    await cleanupChildProcesses(children);
    killProcessTreeByPid(descendantPid);
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
        "const http = require('node:http');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "http.createServer((req, res) => {",
        "  res.end(req.url === '/status' ? 'packager-status:running' : 'expo-owned');",
        "}).listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/' + port, String(process.pid)));",
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
      baseEnv: buildExpoFixtureEnv({
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
      }),
      apiServerUrl: 'http://localhost:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: uniqueStackName('qa-agent-1'),
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
    await cleanupChildProcesses(children);
    await new Promise((resolve) => metro?.close(() => resolve())).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer restarts mobile dev-client when running Expo state targets a different API server URL', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-restart-mobile-api-url-'));
  const children = [];
  let previousExpo = null;
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
        "const http = require('node:http');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/' + port, String(process.pid)));",
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
    const stackName = uniqueStackName('qa-agent-mobile-api-url');
    const envPath = join(tmp, 'stack.env');
    const cliHomeDir = join(tmp, 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    previousExpo = await spawnReadyFixture({
        __UNSAFE_EXPO_HOME_DIRECTORY: paths.expoHomeDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    });
    const previousExpoPid = previousExpo.pid;

    const priorPort = await listenEphemeralPort();
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
      baseEnv: buildExpoFixtureEnv({
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_MOBILE_SCHEME: 'happier-dev',
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      }),
      apiServerUrl: 'http://192.168.1.20:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
      readStateProcessIdentityLine: async () =>
        `node __UNSAFE_EXPO_HOME_DIRECTORY=${paths.expoHomeDir}`,
      killOwnedProcessGroup: async (pid) => {
        assert.equal(pid, previousExpo.pid);
        previousExpo.kill('SIGKILL');
        assert.equal(await waitForChildExit(previousExpo), true);
        return { killed: true, reason: 'test_boundary' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    if (process.platform !== 'win32') {
      assert.equal(await waitForChildExit(previousExpo), true, 'expected automatic API mismatch restart to stop prior owned Expo pid');
    }

    const nextState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(nextState.apiServerUrl, 'http://192.168.1.20:3014');
    assert.equal(nextState.devClientEnabled, true);
  } finally {
    await cleanupChildProcesses(children);
    await cleanupChildProcesses([previousExpo]);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer stops prior stack-owned Expo process for automatic Tailscale mismatch restart', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-restart-tailscale-'));
  const children = [];
  let previousExpo = null;
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
        "const http = require('node:http');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "http.createServer((req, res) => {",
        "  res.end(req.url === '/status' ? 'packager-status:running' : 'expo-owned');",
        "}).listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/' + port, String(process.pid)));",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const tailscaleBin = join(tmp, 'tailscale');
    const bindableForwarderIp = pickLanIpv4();
    assert.ok(bindableForwarderIp, 'expected a bindable non-loopback fixture address');
    await writeFile(
      tailscaleBin,
      [
        `#!${process.execPath}`,
        "if (process.argv.slice(2).join(' ') === 'ip -4') {",
        `  console.log(${JSON.stringify(bindableForwarderIp)});`,
        '  process.exit(0);',
        '}',
        'process.exit(1);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(tailscaleBin, 0o755);

    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    const stackName = uniqueStackName('qa-agent-tailscale-restart');
    const envPath = join(tmp, 'stack.env');
    const cliHomeDir = join(tmp, 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    previousExpo = await spawnReadyFixture({
        __UNSAFE_EXPO_HOME_DIRECTORY: paths.expoHomeDir,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    });
    const previousExpoPid = previousExpo.pid;

    const priorPort = await listenEphemeralPort();
    await writePidState(paths.statePath, {
      pid: previousExpoPid,
      port: priorPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: false,
      devClientEnabled: true,
      host: 'localhost',
      apiServerUrl: 'http://127.0.0.1:3016',
      scheme: 'happier-dev',
      tailscaleEnabled: false,
    });

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildExpoFixtureEnv({
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_HOST: 'localhost',
        HAPPIER_STACK_MOBILE_SCHEME: 'happier-dev',
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      }),
      apiServerUrl: 'http://localhost:3016',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      expoTailscale: true,
      quiet: true,
      readStateProcessIdentityLine: async () =>
        `node __UNSAFE_EXPO_HOME_DIRECTORY=${paths.expoHomeDir}`,
      killOwnedProcessGroup: async (pid) => {
        assert.equal(pid, previousExpo.pid);
        previousExpo.kill('SIGKILL');
        assert.equal(await waitForChildExit(previousExpo), true);
        return { killed: true, reason: 'test_boundary' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.tailscale?.ok, true, result.tailscale?.error ?? 'expected Tailscale forwarder to start');
    if (process.platform !== 'win32') {
      assert.equal(await waitForChildExit(previousExpo), true, 'expected automatic Tailscale mismatch restart to stop prior owned Expo pid');
    }

    const nextState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(nextState.tailscaleEnabled, true);
    assert.equal(nextState.tailscaleIp, bindableForwarderIp);
  } finally {
    await cleanupChildProcesses(children);
    await cleanupChildProcesses([previousExpo]);
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
        "const http = require('node:http');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(port, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/' + port, String(process.pid)));",
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
      baseEnv: buildExpoFixtureEnv({
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'ephemeral',
      }),
      apiServerUrl: 'http://localhost:3014',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: uniqueStackName('qa-agent-4'),
      envPath: join(tmp, 'stack.env'),
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.notEqual(result.port, priorPort);
  } finally {
    await cleanupChildProcesses(children);
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
          baseEnv: buildExpoFixtureEnv({
            HAPPIER_STACK_EXPO_DEV_PORT: String(occupiedPort),
            HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
            HAPPIER_STACK_EXPO_DEV_PORT_BASE: '51000',
            HAPPIER_STACK_EXPO_DEV_PORT_RANGE: '2000',
          }),
          apiServerUrl: 'http://127.0.0.1:1',
          restart: false,
          stackMode: true,
          runtimeStatePath: null,
          stackName: uniqueStackName('qa-agent-update-env'),
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
    await cleanupChildProcesses(children);
    await new Promise((resolve) => metro?.close(() => resolve())).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer in stable port mode stops stack-owned leftover Expo processes holding the forced port (no bump)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-stable-stop-leftovers-'));
  const children = [];
  let holder = null;
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
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/' + port, String(process.pid));",
        "http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok')).listen(port, '127.0.0.1');",
      ].join('\n') + '\n',
      'utf-8',
    );
    await chmod(expoBin, 0o755);

    const occupiedPort = await listenEphemeralPort();
    const projectDir = uiDir;
    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });

    const stackName = uniqueStackName('qa-owned-expo-leftover');
    const cliHomeDir = join(tmp, 'cli');
    await mkdir(cliHomeDir, { recursive: true });

    // Spawn a process that (1) holds the port and (2) carries the same Expo isolation env marker,
    // so ensureDevExpoServer can identify and stop it without bumping the stable port.
    holder = spawnDetachedTestProcess(
      process.execPath,
      [
        '-e',
        [
          "const net = require('net');",
          "const fs = require('node:fs');",
          'const port = Number(process.env.TEST_PORT);',
          "const marker = process.env.TEST_EXPO_LISTENER_DIR + '/' + port;",
          "const srv = net.createServer(() => {});",
          "srv.listen(port, undefined, () => { fs.writeFileSync(marker, String(process.pid)); process.stdout.write('ready\\n'); });",
          "process.on('SIGTERM', () => { try { fs.unlinkSync(marker); } catch {} srv.close(() => process.exit(0)); });",
          "setInterval(() => {}, 1000);",
        ].join(''),
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: buildExpoFixtureEnv({
          TEST_PORT: String(occupiedPort),
          __UNSAFE_EXPO_HOME_DIRECTORY: paths.expoHomeDir,
          HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
          HAPPIER_STACK_PROCESS_KIND: 'infra',
        }),
      }
    );
    const holderReady = once(holder.stdout, 'data');
    await once(holder, 'spawn');
    await holderReady;

    const envPath = join(tmp, 'stack.env');
    await writeFile(envPath, `HAPPIER_STACK_EXPO_DEV_PORT=${occupiedPort}\n`, 'utf-8');

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildExpoFixtureEnv({
        HAPPIER_STACK_EXPO_DEV_PORT: String(occupiedPort),
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS: '15000',
        HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS: '25',
        TEST_EXPO_LISTENER_MARKERS_ONLY: '1',
      }),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName,
      envPath,
      children,
      quiet: true,
      getProcessIdentityLine: async (pid) => pid === holder.pid
        ? `node __UNSAFE_EXPO_HOME_DIRECTORY=${paths.expoHomeDir} HAPPIER_STACK_STACK=${stackName}`
        : null,
      getProcessGroupIdForCleanup: async (pid) => Number(pid),
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, occupiedPort);
  } finally {
    await cleanupChildProcesses(children);
    await cleanupChildProcesses([holder]);
    await rm(tmp, { recursive: true, force: true });
  }
});
