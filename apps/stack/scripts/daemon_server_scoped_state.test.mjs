import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkDaemonState, cleanupStaleDaemonState } from './daemon.mjs';
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

test('cleanupStaleDaemonState removes stale server-scoped lock and state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-'));
  try {
    const serverUrl = 'http://127.0.0.1:4111';
    const paths = resolveStackDaemonStatePaths({ cliHomeDir: dir, serverUrl });
    const stalePid = 999999;

    await mkdir(dirname(paths.serverScopedStatePath), { recursive: true });
    await writeFile(paths.serverScopedStatePath, JSON.stringify({ pid: stalePid, httpPort: 4321 }) + '\n', 'utf-8');
    await writeFile(paths.serverScopedLockPath, `${stalePid}\n`, 'utf-8');

    await cleanupStaleDaemonState(dir, { serverUrl });

    const after = checkDaemonState(dir, { serverUrl });
    assert.equal(after.status, 'stopped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkDaemonState falls back to an older running daemon when the newest fallback state is stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-'));
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: dir,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });

  try {
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

    const state = checkDaemonState(dir, { serverUrl: '' });
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
