import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readStackRuntimeStateFile,
  recordStackRuntimeStart,
  recordStackRuntimeStopRequest,
} from './runtime_state.mjs';

test('recordStackRuntimeStart refreshes startedAt when the owner pid changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  const first = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid + 100000,
    ports: { server: 23456 },
  });

  assert.notEqual(second.startedAt, first.startedAt);
});

test('recordStackRuntimeStopRequest persists stop attribution details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeStopRequest(statePath, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
  });

  const state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.stopRequest, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
    requestedAt: state?.stopRequest?.requestedAt,
  });
  assert.equal(typeof state?.stopRequest?.requestedAt, 'string');
});
