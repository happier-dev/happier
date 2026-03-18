import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import {
  inspectExistingStartLikeRuntime,
  shouldAdoptOccupiedRuntimePortsForRecovery,
} from './stack/run_script_with_stack_env.mjs';

async function withListeningServer() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;
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

async function withTempDir() {
  const dir = await mkdtemp(join(os.tmpdir(), 'hstack-test-'));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function spawnMetroLikeServer({ includeNeedle = '' } = {}) {
  const needle = String(includeNeedle ?? '').trim();
  const script = `
    const http = require('http');
    const needle = process.argv[2] || '';
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.statusCode = 200;
        res.end('packager-status:running');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      console.log(JSON.stringify({ port, pid: process.pid, needle }));
    });
    setInterval(() => {}, 1000);
  `.trim();
  const args = ['-e', script, ...(needle ? [needle] : [])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) resolve(buf.slice(0, idx));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`[test] metro-like child exited unexpectedly (code=${code ?? 'unknown'})`)));
  });
  const meta = JSON.parse(String(line ?? '').trim());
  return {
    child,
    port: Number(meta.port),
    needle: String(meta.needle ?? ''),
    async kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    },
  };
}

test('inspectExistingStartLikeRuntime does not short-circuit dev when server is up but Expo UI is down', async () => {
  const server = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  try {
    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        webPort: staleUiPort,
        port: staleUiPort,
        webEnabled: true,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, false);
    assert.equal(status.canShortCircuit, false);
    assert.equal(status.wasRunning, true);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), true);
  } finally {
    await server.close();
  }
});

test('inspectExistingStartLikeRuntime allows dev short-circuit when stack Expo state is running', async () => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const metroNeedle = join(os.tmpdir(), 'hstack-metro-needle');
  const metro = await spawnMetroLikeServer({ includeNeedle: metroNeedle });
  const temp = await withTempDir();
  const envPath = join(temp.dir, 'env');
  await writeFile(envPath, 'DUMMY=1\n', 'utf8');
  try {
    const expoDevRoot = join(temp.dir, 'expo-dev', 'abc123');
    await mkdir(expoDevRoot, { recursive: true });
    await writeFile(
      join(expoDevRoot, 'expo.state.json'),
      JSON.stringify({ pid: 999999, port: metro.port, projectDir: metroNeedle, webEnabled: true }, null, 2) + '\n',
      'utf8'
    );

    const staleUiPort = await reserveUnusedPort();
    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        webPort: staleUiPort,
        port: staleUiPort,
        webEnabled: true,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, true);
    assert.equal(status.canShortCircuit, true);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), false);
  } finally {
    await server.close();
    await metro.kill();
    await temp.cleanup();
  }
});

test('inspectExistingStartLikeRuntime does not treat an unrelated Metro as stack UI', async () => {
  const stackName = 'test-stack';
  const envPath = join(os.tmpdir(), 'hstack-env-file-does-not-exist');
  const temp = await withTempDir();
  const server = await withListeningServer();
  const metro = await spawnMetroLikeServer();
  try {
    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        webPort: metro.port,
        port: metro.port,
        webEnabled: true,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, false);
    assert.equal(status.canShortCircuit, false);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), true);
  } finally {
    await metro.kill();
    await server.close();
    await temp.cleanup();
  }
});

test('inspectExistingStartLikeRuntime does not short-circuit dev when Expo state is for a different UI dir', async () => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const temp = await withTempDir();
  const envPath = join(temp.dir, 'env');
  await writeFile(envPath, 'DUMMY=1\n', 'utf8');

  const stateProjectDir = join(os.tmpdir(), 'hstack-metro-project-a');
  const expectedUiDir = join(os.tmpdir(), 'hstack-metro-project-b');
  const metro = await spawnMetroLikeServer({ includeNeedle: stateProjectDir });
  try {
    const expoDevRoot = join(temp.dir, 'expo-dev', 'abc123');
    await mkdir(expoDevRoot, { recursive: true });
    await writeFile(
      join(expoDevRoot, 'expo.state.json'),
      JSON.stringify({ pid: 999999, port: metro.port, projectDir: stateProjectDir, webEnabled: true }, null, 2) + '\n',
      'utf8'
    );

    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: { serverPid: 999_999_998, expoPid: 999_999_997 },
      expo: { webPort: metro.port, port: metro.port, webEnabled: true },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      expectedUiDir,
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, false);
    assert.equal(status.canShortCircuit, false);
  } finally {
    await metro.kill();
    await server.close();
    await temp.cleanup();
  }
});
