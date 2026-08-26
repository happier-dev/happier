import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getManagedLimaStatus,
  ManagedLimaDriftError,
  reconcileManagedLimaInstance,
  startManagedLimaInstance,
  stopManagedLimaInstance,
} from './lifecycle.mjs';
import { resolveManagedLimaProfile } from './profiles.mjs';

function fakeExecutor(responses) {
  const calls = [];
  return {
    calls,
    async capture(command, args) {
      calls.push({ kind: 'capture', command, args });
      const key = `${command} ${args.join(' ')}`;
      const value = responses[key];
      if (typeof value === 'function') return value();
      return value ?? { exitCode: 0, out: '', err: '' };
    },
    async run(command, args) {
      calls.push({ kind: 'run', command, args });
      return { exitCode: 0 };
    },
  };
}

const profile = resolveManagedLimaProfile('balanced');

function compatibleInstance(overrides = {}) {
  return {
    name: 'happier-agent-primary',
    status: 'Running',
    vmType: 'vz',
    arch: 'aarch64',
    cpus: 10,
    memory: 24 * 1024 ** 3,
    disk: 160 * 1024 ** 3,
    config: {
      mounts: [],
      vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
      ssh: { forwardAgent: false },
      containerd: { user: false, system: false },
      portForwards: [
        { guestPortRange: [13000, 13999], hostPortRange: [13000, 13999] },
        { guestPortRange: [18000, 19099], hostPortRange: [18000, 19099] },
      ],
    },
    ...overrides,
  };
}

test('managed Lima reconcile creates and starts a missing retained instance exactly once', async () => {
  const executor = fakeExecutor({
    'uname -s': { exitCode: 0, out: 'Darwin\n', err: '' },
    'limactl --version': { exitCode: 0, out: 'limactl version 2.1.0\n', err: '' },
    'limactl list --all-fields --format=json happier-agent-primary': { exitCode: 0, out: '', err: '' },
  });

  const result = await reconcileManagedLimaInstance({
    executor,
    instance: 'happier-agent-primary',
    profile,
  });

  assert.equal(result.created, true);
  assert.equal(result.started, true);
  assert.equal(executor.calls.filter((call) => call.kind === 'run' && call.args[0] === 'create').length, 1);
  assert.deepEqual(executor.calls.at(-1), {
    kind: 'run', command: 'limactl', args: ['start', 'happier-agent-primary'],
  });
  assert.equal(executor.calls.some((call) => call.args.includes('delete')), false);
});

test('managed Lima reconcile is idempotent for a compatible running instance', async () => {
  const executor = fakeExecutor({
    'uname -s': { exitCode: 0, out: 'Darwin\n', err: '' },
    'limactl --version': { exitCode: 0, out: 'limactl version 2.1.0\n', err: '' },
    'limactl list --all-fields --format=json happier-agent-primary': {
      exitCode: 0,
      out: `${JSON.stringify(compatibleInstance())}\n`,
      err: '',
    },
  });

  const result = await reconcileManagedLimaInstance({ executor, instance: 'happier-agent-primary', profile });

  assert.deepEqual(result, { created: false, started: false, status: 'Running' });
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima reconcile refuses creation-only drift without stopping or recreating retained data', async () => {
  const executor = fakeExecutor({
    'uname -s': { exitCode: 0, out: 'Darwin\n', err: '' },
    'limactl --version': { exitCode: 0, out: 'limactl version 2.1.0\n', err: '' },
    'limactl list --all-fields --format=json happier-agent-primary': {
      exitCode: 0,
      out: `${JSON.stringify(compatibleInstance({ status: 'Stopped', vmType: 'qemu' }))}\n`,
      err: '',
    },
  });

  await assert.rejects(
    reconcileManagedLimaInstance({ executor, instance: 'happier-agent-primary', profile }),
    (error) => error instanceof ManagedLimaDriftError
      && error.code === 'MANAGED_LIMA_CREATION_DRIFT'
      && error.drift.some((entry) => entry.field === 'vmType'),
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima reconcile rejects mount, containerd, forwarding, and port drift without mutating the instance', async () => {
  const incompatible = compatibleInstance();
  incompatible.config = {
    ...incompatible.config,
    mounts: [{ location: '/Users/worker' }],
    containerd: { user: true, system: false },
    ssh: { forwardAgent: true },
    portForwards: [],
  };
  const executor = fakeExecutor({
    'uname -s': { exitCode: 0, out: 'Darwin\n', err: '' },
    'limactl --version': { exitCode: 0, out: 'limactl version 2.1.0\n', err: '' },
    'limactl list --all-fields --format=json happier-agent-primary': {
      exitCode: 0, out: `${JSON.stringify(incompatible)}\n`, err: '',
    },
  });

  await assert.rejects(
    reconcileManagedLimaInstance({ executor, instance: 'happier-agent-primary', profile }),
    (error) => error.code === 'MANAGED_LIMA_CONFIGURATION_DRIFT'
      && new Set(error.drift.map((entry) => entry.field)).size === 4,
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima start and stop are idempotent and never imply create or delete', async () => {
  let status = 'Stopped';
  const executor = fakeExecutor({
    'limactl list --all-fields --format=json happier-agent-primary': () => ({
      exitCode: 0,
      out: `${JSON.stringify(compatibleInstance({ status }))}\n`,
      err: '',
    }),
  });

  assert.deepEqual(await startManagedLimaInstance({ executor, instance: 'happier-agent-primary' }), {
    changed: true, status: 'Running',
  });
  status = 'Running';
  assert.deepEqual(await startManagedLimaInstance({ executor, instance: 'happier-agent-primary' }), {
    changed: false, status: 'Running',
  });
  assert.deepEqual(await stopManagedLimaInstance({ executor, instance: 'happier-agent-primary' }), {
    changed: true, status: 'Stopped',
  });
  status = 'Stopped';
  assert.deepEqual(await stopManagedLimaInstance({ executor, instance: 'happier-agent-primary' }), {
    changed: false, status: 'Stopped',
  });
  assert.equal(executor.calls.some((call) => call.args.includes('create') || call.args.includes('delete')), false);
});

test('managed Lima status reports an absent retained instance without creating it', async () => {
  const executor = fakeExecutor({
    'limactl list --all-fields --format=json happier-agent-primary': { exitCode: 0, out: '', err: '' },
  });
  assert.deepEqual(await getManagedLimaStatus({ executor, instance: 'happier-agent-primary' }), {
    exists: false,
    status: 'Absent',
    instance: null,
  });
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima status treats Lima 2.2 unmatched-instance output as an absent retained instance', async () => {
  const executor = fakeExecutor({
    'limactl list --all-fields --format=json happier-agent-primary': {
      exitCode: 1,
      out: '',
      err: 'level=warning msg="No instance matching happier-agent-primary found."\nlevel=fatal msg="unmatched instances"\n',
    },
  });

  assert.deepEqual(await getManagedLimaStatus({ executor, instance: 'happier-agent-primary' }), {
    exists: false,
    status: 'Absent',
    instance: null,
  });
});
