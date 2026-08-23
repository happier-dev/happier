import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as daemonModule from './daemon.mjs';
import { checkDaemonState, checkDaemonStatePingAware, daemonStateHasLiveProcess } from './daemon.mjs';
import { spawnDetachedInlineNodeTestProcess } from './testkit/core/spawn_test_process.mjs';
import { resolveStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';

test('checkDaemonState reads server-scoped daemon state for active server URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-'));
  try {
    const serverUrl = 'http://127.0.0.1:4101';
    const paths = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });

    await mkdir(dirname(paths.serverScopedStatePath), { recursive: true });
    await writeFile(
      paths.serverScopedStatePath,
      JSON.stringify({ pid: process.pid, httpPort: 4321, startTime: new Date().toISOString() }) + '\n',
      'utf-8'
    );

    const state = checkDaemonState(dir, { serverUrl });
    assert.equal(state.status, 'running');
    assert.equal(state.pid, process.pid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkDaemonStatePingAware requires a live authenticated control ping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-ping-'));
  let pingOk = false;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
      res.statusCode = pingOk ? 200 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: pingOk,
        ...(pingOk ? { distClosureFingerprint: 'abcdef1234567890' } : {}),
      }));
      return;
    }
    res.statusCode = 401;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const serverUrl = 'http://127.0.0.1:4102';
    const paths = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });
    await mkdir(dirname(paths.serverScopedStatePath), { recursive: true });
    await writeFile(
      paths.serverScopedStatePath,
      JSON.stringify({
        pid: process.pid,
        httpPort: server.address().port,
        controlToken: 'state-token',
        startTime: new Date().toISOString(),
      }) + '\n',
      'utf-8'
    );

    pingOk = false;
    const unreachable = await checkDaemonStatePingAware(dir, { serverUrl });
    assert.deepEqual(unreachable, { status: 'unreachable', pid: process.pid, reason: 'ping_failed' });
    assert.equal(daemonStateHasLiveProcess(unreachable), true);

    pingOk = true;
    assert.deepEqual(
      await checkDaemonStatePingAware(dir, { serverUrl }),
      {
        status: 'running',
        pid: process.pid,
        distClosureFingerprint: 'abcdef1234567890',
        processInstanceFingerprint: null,
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('stack exposes no external daemon-state deletion owner', () => {
  assert.equal('cleanupStaleDaemonState' in daemonModule, false);
});

test('checkDaemonState falls back to an older running daemon when the newest fallback state is stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-'));
  const running = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1e6)', {
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: dir,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(running.pid, 0);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const olderServerDir = join(dir, 'servers', 'stack_live__id_default');
    const newerServerDir = join(dir, 'servers', 'stack_stale__id_default');
    await mkdir(olderServerDir, { recursive: true });
    await mkdir(newerServerDir, { recursive: true });

    await writeFile(
      join(olderServerDir, 'daemon.state.json'),
      JSON.stringify({ pid: running.pid, httpPort: 4321, startTime: new Date().toISOString() }) + '\n',
      'utf-8'
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(
      join(newerServerDir, 'daemon.state.json'),
      JSON.stringify({ pid: 999999, httpPort: 4322, startTime: new Date().toISOString() }) + '\n',
      'utf-8'
    );

    const state = checkDaemonState(dir, { serverUrl: '', env: {} });
    assert.deepEqual(state, { status: 'running', pid: running.pid });
  } finally {
    try {
      process.kill(-running.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true });
  }
});
