import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths, writePidState } from '../expo/expo.mjs';

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

test('ensureDevExpoServer reserves prior metro port when restart cannot kill previous pid', async () => {
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

    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    foreign.unref();
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
        HAPPIER_STACK_EXPO_DEV_PORT: String(priorPort),
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
    assert.notEqual(result.port, priorPort);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    killProcessTreeByPid(foreignPid);
    await rm(tmp, { recursive: true, force: true });
  }
});
