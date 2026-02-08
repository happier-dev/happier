import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveServerPortForPostAuthDaemonStart } from './utils/auth/orchestrated_stack_auth_flow.mjs';

test('resolveServerPortForPostAuthDaemonStart falls back to env HAPPIER_STACK_SERVER_PORT when runtime is missing it', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-port-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'main';
  const baseDir = join(storageDir, stackName);
  await mkdir(baseDir, { recursive: true });

  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName, ports: {} }) + '\n', 'utf-8');

  const prev = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  try {
    const port = await resolveServerPortForPostAuthDaemonStart({
      stackName,
      env: { ...process.env, HAPPIER_STACK_SERVER_PORT: '4123' },
    });
    assert.equal(port, 4123);
  } finally {
    if (typeof prev === 'undefined') delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = prev;
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('resolveServerPortForPostAuthDaemonStart throws when runtime and env ports are both unusable', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-port-invalid-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'main';
  const baseDir = join(storageDir, stackName);
  await mkdir(baseDir, { recursive: true });

  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName, ports: {} }) + '\n', 'utf-8');

  const prev = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  try {
    await assert.rejects(
      () =>
        resolveServerPortForPostAuthDaemonStart({
          stackName,
          env: { ...process.env, HAPPIER_STACK_SERVER_PORT: 'not-a-port' },
        }),
      /could not resolve server port/i
    );
  } finally {
    if (typeof prev === 'undefined') delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = prev;
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('resolveServerPortForPostAuthDaemonStart ignores runtime port when runtime owner pid is stale', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-port-stale-owner-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'main';
  const baseDir = join(storageDir, stackName);
  await mkdir(baseDir, { recursive: true });

  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({ version: 1, stackName, ownerPid: 999_999_999, ports: { server: 4555 } }) + '\n',
    'utf-8'
  );

  const prev = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  try {
    const port = await resolveServerPortForPostAuthDaemonStart({
      stackName,
      env: { ...process.env, HAPPIER_STACK_SERVER_PORT: '4222' },
    });
    assert.equal(port, 4222);
  } finally {
    if (typeof prev === 'undefined') delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = prev;
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
