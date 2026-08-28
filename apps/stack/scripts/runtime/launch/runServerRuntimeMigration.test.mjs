import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { spawnRuntimeServerAfterMigration } from './runServerRuntimeMigration.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverDir = join(root, 'server');
  await mkdir(serverDir);
  const command = join(serverDir, 'happier-server-migrate');
  await writeFile(command, '#!/bin/sh\nexit 0\n');
  await chmod(command, 0o755);
  return {
    serverDir,
    command,
    spec: {
      serverDir,
      entrypoint: join(serverDir, 'happier-server'),
      command: join(serverDir, 'happier-server'),
      args: [],
      migration: { command, args: [], cwd: serverDir },
    },
  };
}

test('migration terminal success precedes exactly one normal server spawn and the temporary child is not retained', async (t) => {
  const { spec, command, serverDir } = await fixture(t);
  const events = [];
  const children = [];
  const env = { HAPPIER_DB_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://fixture' };
  const server = { pid: 202 };
  const spawnProcImpl = (label, spawnedCommand, args, spawnedEnv, options) => {
    events.push({ label, command: spawnedCommand, args, env: spawnedEnv, cwd: options.cwd });
    return label === 'server-migrate' ? { pid: 101, completion: Promise.resolve({ code: 0, signal: null }) } : server;
  };

  assert.equal(await spawnRuntimeServerAfterMigration({ serverLaunchSpec: spec, env, children, spawnProcImpl }), server);
  assert.deepEqual(events, [
    { label: 'server-migrate', command, args: [], env, cwd: serverDir },
    { label: 'server', command: spec.command, args: [], env, cwd: serverDir },
  ]);
  assert.deepEqual(children, [server]);
});

test('in-process and disabled migration modes start without resolving a sidecar', async (t) => {
  const { spec, serverDir } = await fixture(t);
  for (const mode of ['in-process', 'disabled']) {
    const candidate = { ...spec, migration: { mode } };
    const events = [];
    const server = { pid: mode === 'in-process' ? 303 : 304 };
    assert.equal(await spawnRuntimeServerAfterMigration({
      serverLaunchSpec: candidate,
      env: {},
      children: [],
      spawnProcImpl: (label, command, args, env, options) => {
        events.push({ label, command, args, env, cwd: options.cwd });
        return server;
      },
    }), server);
    assert.deepEqual(events, [{
      label: 'server',
      command: candidate.command,
      args: [],
      env: {},
      cwd: serverDir,
    }]);
  }
});

test('migration admission failures are typed and never spawn the normal server', async (t) => {
  const { spec, serverDir, command } = await fixture(t);
  const outside = join(serverDir, '..', 'happier-server-migrate');
  await writeFile(outside, '#!/bin/sh\nexit 0\n');
  await chmod(outside, 0o755);
  const cases = [
    ['missing capability', { ...spec, migration: undefined }, 'missing_artifact_migration_command'],
    ['escaping command', { ...spec, migration: { command: outside, args: [], cwd: serverDir } }, 'artifact_migration_command_escape'],
    ['missing command', { ...spec, migration: { ...spec.migration, command: join(serverDir, 'happier-server-migrate-missing') } }, 'artifact_migration_command_escape'],
  ];
  for (const [name, candidate, reason] of cases) {
    let spawnCount = 0;
    await assert.rejects(
      spawnRuntimeServerAfterMigration({ serverLaunchSpec: candidate, env: {}, children: [], spawnProcImpl: () => { spawnCount += 1; } }),
      (error) => error.code === 'ERUNTIMESERVERMIGRATIONUNAVAILABLE' && error.reason === reason,
      name,
    );
    assert.equal(spawnCount, 0, name);
  }
  await rm(command);
  for (const [name, prepare] of [
    ['missing regular file', async () => {}],
    ['directory instead of file', async () => { await mkdir(command); }],
  ]) {
    await prepare();
    let exactSpawnCount = 0;
    await assert.rejects(
      spawnRuntimeServerAfterMigration({ serverLaunchSpec: spec, env: {}, children: [], spawnProcImpl: () => { exactSpawnCount += 1; } }),
      (error) => error.code === 'ERUNTIMESERVERMIGRATIONUNAVAILABLE' && error.reason === 'unusable_artifact_migration_command',
      name,
    );
    assert.equal(exactSpawnCount, 0, name);
    await rm(command, { recursive: true, force: true });
  }
  await writeFile(command, 'nope');
  await chmod(command, 0o644);
  let spawnCount = 0;
  await assert.rejects(
    spawnRuntimeServerAfterMigration({ serverLaunchSpec: spec, env: {}, children: [], spawnProcImpl: () => { spawnCount += 1; } }),
    (error) => error.code === 'ERUNTIMESERVERMIGRATIONUNAVAILABLE' && error.reason === 'unusable_artifact_migration_command',
  );
  assert.equal(spawnCount, 0);
});

test('migration terminal failures are typed and never spawn the normal server', async (t) => {
  const { spec } = await fixture(t);
  const cases = [
    ['spawn error', { error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) }, 'ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'spawn_error'],
    ['nonzero', { code: 23, signal: null }, 'ERUNTIMESERVERMIGRATIONFAILED', 'nonzero_exit'],
    ['signal', { code: null, signal: 'SIGTERM' }, 'ERUNTIMESERVERMIGRATIONFAILED', 'signaled'],
    ['abnormal', { code: null, signal: null }, 'ERUNTIMESERVERMIGRATIONFAILED', 'abnormal_completion'],
  ];
  for (const [name, completion, code, reason] of cases) {
    const children = [];
    let serverSpawnCount = 0;
    await assert.rejects(
      spawnRuntimeServerAfterMigration({
        serverLaunchSpec: spec,
        env: {},
        children,
        spawnProcImpl: (label) => {
          if (label === 'server') serverSpawnCount += 1;
          return { completion: Promise.resolve(completion) };
        },
      }),
      (error) => error.code === code && error.reason === reason,
      name,
    );
    assert.equal(serverSpawnCount, 0, name);
    assert.deepEqual(children, [], name);
  }
});

test('startup cancellation fences normal server spawn before and after migration completion', async (t) => {
  const { spec } = await fixture(t);
  const assertCancelled = (error) => error.code === 'ERUNTIMESERVERMIGRATIONCANCELLED'
    && error.reason === 'startup_shutdown_requested';

  const preCancelledLabels = [];
  await assert.rejects(
    spawnRuntimeServerAfterMigration({
      serverLaunchSpec: spec,
      env: {},
      children: [],
      isCancellationRequested: () => true,
      spawnProcImpl: (label) => {
        preCancelledLabels.push(label);
        return { pid: 101, completion: Promise.resolve({ code: 0, signal: null }) };
      },
    }),
    assertCancelled,
  );
  assert.deepEqual(preCancelledLabels, []);

  let cancelled = false;
  let resolveCompletion;
  const children = [];
  const labels = [];
  const result = spawnRuntimeServerAfterMigration({
    serverLaunchSpec: spec,
    env: {},
    children,
    isCancellationRequested: () => cancelled,
    spawnProcImpl: (label) => {
      labels.push(label);
      return { pid: 101, completion: new Promise((resolve) => { resolveCompletion = resolve; }) };
    },
  });
  while (!resolveCompletion) await new Promise((resolve) => setImmediate(resolve));
  cancelled = true;
  resolveCompletion({ code: 0, signal: null });
  await assert.rejects(result, assertCancelled);
  assert.deepEqual(labels, ['server-migrate']);
  assert.deepEqual(children, []);
});
