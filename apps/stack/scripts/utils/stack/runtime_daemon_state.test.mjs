import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getObservedStackDaemon,
  readStackRuntimeStateWithDaemonSync,
  recordStackRuntimeDaemonPid,
  syncStackRuntimeDaemonPidFromDaemonState,
} from './runtime_daemon_state.mjs';

test('getObservedStackDaemon prefers daemon.state over stale runtime daemon pid', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 111,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
      isPidAliveImpl: (pid) => Number(pid) === 111,
    },
  );

  assert.equal(observed.running, true);
  assert.equal(observed.pid, 222);
  assert.equal(observed.source, 'daemon_state');
});

test('getObservedStackDaemon treats dead runtime daemon pid as stopped when daemon state is not running', () => {
  const observed = getObservedStackDaemon(
    {
      cliHomeDir: '/tmp/stack-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      runtimeDaemonPid: 333,
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
      isPidAliveImpl: () => false,
    },
  );

  assert.equal(observed.running, false);
  assert.equal(observed.pid, null);
  assert.equal(observed.status, 'stopped');
});

test('syncStackRuntimeDaemonPidFromDaemonState records the live daemon pid without disturbing sibling process metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-state-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
    },
  );

  assert.equal(result.running, true);
  assert.equal(result.pid, 222);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 222);
});

test('syncStackRuntimeDaemonPidFromDaemonState clears stale runtime daemon pid when daemon is stopped', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-clear-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 999,
      },
    }) + '\n',
    'utf-8',
  );

  const result = await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'stopped', pid: null }),
    },
  );

  assert.equal(result.running, false);
  assert.equal(result.pid, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
});

test('recordStackRuntimeDaemonPid clears daemon pid when requested explicitly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-record-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        daemonPid: 444,
      },
    }) + '\n',
    'utf-8',
  );

  await recordStackRuntimeDaemonPid(runtimeStatePath, null);

  const runtime = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(runtime?.processes?.daemonPid, null);
});

test('readStackRuntimeStateWithDaemonSync returns the refreshed daemon pid after syncing from daemon.state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-daemon-read-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await mkdir(root, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev',
      processes: {
        serverPid: 1234,
        daemonPid: 111,
      },
    }) + '\n',
    'utf-8',
  );

  const runtime = await readStackRuntimeStateWithDaemonSync(
    {
      runtimeStatePath,
      cliHomeDir: join(root, 'cli'),
      internalServerUrl: 'http://127.0.0.1:3009',
      env: {},
    },
    {
      checkDaemonStateImpl: () => ({ status: 'running', pid: 222 }),
    },
  );

  assert.equal(runtime?.processes?.serverPid, 1234);
  assert.equal(runtime?.processes?.daemonPid, 222);
});
