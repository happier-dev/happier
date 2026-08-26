import assert from 'node:assert/strict';
import test from 'node:test';

import {
  doctorManagedLimaInstance,
  setupManagedLimaInstance,
  setupManagedLimaRuntime,
} from './manager.mjs';

function executorWithLimaProbe({ installed }) {
  const calls = [];
  let nowInstalled = installed;
  return {
    calls,
    async capture(command, args) {
      calls.push({ kind: 'capture', command, args });
      if (command === 'uname') return { exitCode: 0, out: 'Darwin\n', err: '' };
      if (command === 'limactl' && args[0] === '--version') {
        return nowInstalled
          ? { exitCode: 0, out: 'limactl version 2.1.0\n', err: '' }
          : { exitCode: 127, out: '', err: 'not found' };
      }
      if (command === 'brew' && args[0] === '--version') return { exitCode: 0, out: 'Homebrew 4.6.0\n', err: '' };
      if (command === 'limactl' && args[0] === 'list') return { exitCode: 0, out: '', err: '' };
      return { exitCode: 0, out: '', err: '' };
    },
    async run(command, args) {
      calls.push({ kind: 'run', command, args });
      if (command === 'brew' && args.join(' ') === 'install lima') nowInstalled = true;
      return { exitCode: 0 };
    },
  };
}

test('explicit managed Lima setup installs Lima before reconciling when it is absent', async () => {
  const executor = executorWithLimaProbe({ installed: false });

  const result = await setupManagedLimaInstance({
    executor,
    instance: 'happier-agent-primary',
    profileName: 'small',
    allowInstall: true,
  });

  assert.equal(result.installed, true);
  assert.deepEqual(
    executor.calls.find((call) => call.kind === 'run' && call.command === 'brew'),
    { kind: 'run', command: 'brew', args: ['install', 'lima'] },
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run' && call.args[0] === 'create'), true);
});

test('explicit setup accepts a usable Lima install when Homebrew fails only after installation', async () => {
  const executor = executorWithLimaProbe({ installed: false });
  const run = executor.run.bind(executor);
  executor.run = async (command, args) => {
    const result = await run(command, args);
    if (command === 'brew' && args.join(' ') === 'install lima') {
      throw new Error('brew cleanup failed after pouring lima');
    }
    return result;
  };

  const result = await setupManagedLimaInstance({
    executor,
    instance: 'happier-agent-primary',
    profileName: 'small',
    allowInstall: true,
  });

  assert.equal(result.installed, true);
  assert.equal(executor.calls.some((call) => call.kind === 'run' && call.args[0] === 'create'), true);
});

test('managed Lima setup fails with explicit guidance instead of installing during ordinary reconcile', async () => {
  const executor = executorWithLimaProbe({ installed: false });

  await assert.rejects(
    setupManagedLimaInstance({
      executor,
      instance: 'happier-agent-primary',
      profileName: 'small',
      allowInstall: false,
    }),
    (error) => error.code === 'MANAGED_LIMA_NOT_INSTALLED' && /explicit managed setup/.test(error.message),
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima doctor reports retained drift without mutating or stopping the VM', async () => {
  const executor = executorWithLimaProbe({ installed: true });
  const listCall = executor.capture.bind(executor);
  executor.capture = async (command, args) => {
    if (command === 'limactl' && args[0] === 'list') {
      return {
        exitCode: 0,
        out: `${JSON.stringify({
          name: 'happier-agent-primary',
          status: 'Running',
          vmType: 'qemu',
          arch: 'aarch64',
          cpus: 4,
          memory: 8 * 1024 ** 3,
          disk: 100 * 1024 ** 3,
          config: {},
        })}\n`,
        err: '',
      };
    }
    return listCall(command, args);
  };

  const result = await doctorManagedLimaInstance({
    executor,
    instance: 'happier-agent-primary',
    profileName: 'small',
  });

  assert.equal(result.ok, false);
  assert.equal(result.exists, true);
  assert.equal(result.drift.creation.some((entry) => entry.field === 'vmType'), true);
  assert.equal(result.drift.resources.some((entry) => entry.field === 'memory'), true);
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima doctor reports an unresponsive guest login manager without repairing it', async () => {
  const executor = executorWithLimaProbe({ installed: true });
  const originalCapture = executor.capture.bind(executor);
  executor.capture = async (command, args) => {
    if (command === 'limactl' && args[0] === 'list') {
      return {
        exitCode: 0,
        out: `${JSON.stringify({
          name: 'happier-agent-primary', status: 'Running', vmType: 'vz', arch: 'aarch64',
          cpus: 8, memory: 16 * 1024 ** 3, disk: 160 * 1024 ** 3,
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
        })}\n`,
        err: '',
      };
    }
    if (command === 'limactl' && args[0] === 'shell') {
      return { exitCode: 124, out: '', err: 'loginctl timed out' };
    }
    return originalCapture(command, args);
  };

  const result = await doctorManagedLimaInstance({
    executor,
    instance: 'happier-agent-primary',
    profileName: 'small',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.guestLoginManager, { ok: false, error: 'loginctl timed out' });
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('explicit setup reconciles mutable resource/config drift while preserving retained disk identity', async () => {
  const executor = executorWithLimaProbe({ installed: true });
  const originalCapture = executor.capture.bind(executor);
  executor.capture = async (command, args) => {
    if (command === 'limactl' && args[0] === 'list') {
      return {
        exitCode: 0,
        out: `${JSON.stringify({
          name: 'happier-agent-primary', status: 'Running', vmType: 'vz', arch: 'aarch64',
          cpus: 4, memory: 8 * 1024 ** 3, disk: 100 * 1024 ** 3,
          config: {
            mounts: [{ location: '/Users/worker' }],
            vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
            ssh: { forwardAgent: false },
            containerd: { user: true, system: false },
            portForwards: [],
          },
        })}\n`,
        err: '',
      };
    }
    return originalCapture(command, args);
  };

  const result = await setupManagedLimaInstance({
    executor,
    instance: 'happier-agent-primary',
    profileName: 'small',
    allowInstall: false,
  });

  assert.equal(result.reconfigured, true);
  assert.deepEqual(executor.calls.filter((call) => call.kind === 'run').map((call) => call.args[0]), [
    'stop', 'edit', 'start',
  ]);
  assert.equal(executor.calls.some((call) => call.args.includes('delete')), false);
});

test('explicit setup refuses disk shrink instead of risking retained data', async () => {
  const executor = executorWithLimaProbe({ installed: true });
  const originalCapture = executor.capture.bind(executor);
  executor.capture = async (command, args) => {
    if (command === 'limactl' && args[0] === 'list') {
      return {
        exitCode: 0,
        out: `${JSON.stringify({
          name: 'happier-agent-primary', status: 'Stopped', vmType: 'vz', arch: 'aarch64',
          cpus: 8, memory: 16 * 1024 ** 3, disk: 320 * 1024 ** 3,
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
        })}\n`,
        err: '',
      };
    }
    return originalCapture(command, args);
  };

  await assert.rejects(
    setupManagedLimaInstance({ executor, instance: 'happier-agent-primary', profileName: 'small' }),
    (error) => error.code === 'MANAGED_LIMA_DISK_SHRINK_REFUSED',
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima runtime setup provisions the retained guest after lifecycle reconciliation', async () => {
  const executor = executorWithLimaProbe({ installed: true });
  const provisions = [];
  const loginManagerChecks = [];
  const inspections = [];

  const result = await setupManagedLimaRuntime({
    executor,
    instance: 'happier-agent-primary',
    profileName: 'small',
    guestProvisionScriptSource: '#!/usr/bin/env bash\nexit 0\n',
    provisionGuest: async (input) => {
      provisions.push(input);
      return { changed: true, version: 'abc123' };
    },
    ensureGuestLoginManager: async (input) => {
      loginManagerChecks.push(input);
      return { repaired: false };
    },
    inspectGuest: async (input) => {
      inspections.push(input);
      return { homeDir: '/home/guest.actual', user: 'guest' };
    },
  });

  assert.equal(result.created, true);
  assert.deepEqual(result.provision, { changed: true, version: 'abc123' });
  assert.deepEqual(result.guestLoginManager, { repaired: false });
  assert.deepEqual(result.guest, { homeDir: '/home/guest.actual', user: 'guest' });
  assert.equal(provisions.length, 1);
  assert.equal(loginManagerChecks.length, 1);
  assert.equal(inspections.length, 1);
  assert.equal(provisions[0].instance, 'happier-agent-primary');
  assert.equal(provisions[0].scriptSource, '#!/usr/bin/env bash\nexit 0\n');
});
