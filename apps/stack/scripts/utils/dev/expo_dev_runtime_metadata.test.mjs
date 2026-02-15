import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';
import { readStackRuntimeStateFile } from '../stack/runtime_state.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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

test('ensureDevExpoServer in stack mode starts managed Expo instead of adopting port-fallback state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-runtime-meta-'));
  const uiDir = join(tmp, 'ui');
  const projectDir = uiDir;
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const envPath = join(tmp, 'stack.env');
  const children = [];
  const metro = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('packager-status:running');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  try {
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

    await listen(metro);
    const addr = metro.address();
    assert.ok(addr && typeof addr === 'object' && typeof addr.port === 'number');
    const metroPort = addr.port;

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir,
      stateFileName: 'expo.state.json',
    });
    await writePidState(paths.statePath, {
      pid: 999999, // intentionally stale
      port: metroPort,
      uiDir,
      projectDir,
      startedAt: new Date().toISOString(),
      webEnabled: true,
      devClientEnabled: false,
      host: 'lan',
      apiServerUrl: 'http://127.0.0.1:3009',
    });

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      expoProjectDir: projectDir,
      autostart: { baseDir: tmp },
      baseEnv: { ...process.env },
      apiServerUrl: 'http://127.0.0.1:3009',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-agent-4',
      envPath,
      children,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(Number.isFinite(Number(result.pid)) && Number(result.pid) > 1, true);
    assert.notEqual(result.port, metroPort);

    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.ok(runtime && typeof runtime === 'object');
    assert.equal(Number.isFinite(Number(runtime?.processes?.expoPid)) && Number(runtime?.processes?.expoPid) > 1, true);
    assert.equal(runtime?.expo?.webPort, result.port);
    assert.notEqual(runtime?.expo?.webPort, metroPort);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await close(metro).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});
