import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureManagedLimaGuestLoginManager,
  inspectManagedLimaGuestIdentity,
  provisionManagedLimaGuest,
} from './provisioner.mjs';

function fakeExecutor({ ready = false } = {}) {
  const calls = [];
  return {
    calls,
    async capture(command, args, options = {}) {
      calls.push({ kind: 'capture', command, args, options });
      if (args.includes('test')) return { exitCode: ready ? 0 : 1, out: '', err: '' };
      return { exitCode: 0, out: '', err: '' };
    },
    async run(command, args, options = {}) {
      calls.push({ kind: 'run', command, args, options });
      return { exitCode: 0, out: '', err: '' };
    },
  };
}

test('managed Lima guest provisioning streams the canonical script and writes a content-addressed readiness marker', async () => {
  const executor = fakeExecutor();
  const scriptSource = '#!/usr/bin/env bash\necho provisioned\n';

  const result = await provisionManagedLimaGuest({
    executor,
    instance: 'happier-agent-primary',
    scriptSource,
    profile: 'happier',
    nodeMajor: '24',
    yarnVersion: '1.22.22',
  });

  assert.equal(result.changed, true);
  assert.match(result.version, /^[a-f0-9]{64}$/);
  const provision = executor.calls.find((call) => call.kind === 'run' && call.options.input === scriptSource);
  assert.ok(provision);
  assert.deepEqual(provision.args.slice(0, 4), ['shell', 'happier-agent-primary', '--', 'env']);
  assert.ok(provision.args.includes('HAPPIER_PROVISION_NODE_MAJOR=24'));
  assert.ok(provision.args.includes('HAPPIER_PROVISION_YARN_VERSION=1.22.22'));
  assert.deepEqual(provision.args.slice(-4), ['bash', '-s', '--', '--profile=happier']);
  assert.equal(executor.calls.some((call) => call.args.includes('delete')), false);
  assert.equal(executor.calls.at(-1).kind, 'run');
  assert.match(executor.calls.at(-1).args.at(-1), new RegExp(`${result.version}\\.ready`));
});

test('managed Lima guest provisioning is idempotent for the exact script and toolchain inputs', async () => {
  const executor = fakeExecutor({ ready: true });

  const result = await provisionManagedLimaGuest({
    executor,
    instance: 'happier-agent-primary',
    scriptSource: '#!/usr/bin/env bash\nexit 0\n',
  });

  assert.equal(result.changed, false);
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('managed Lima guest provisioning rejects unsupported profiles and unsafe toolchain values before execution', async () => {
  const executor = fakeExecutor();
  await assert.rejects(
    provisionManagedLimaGuest({ executor, instance: 'worker', scriptSource: 'exit 0', profile: 'unknown' }),
    /unsupported guest provisioning profile/,
  );
  await assert.rejects(
    provisionManagedLimaGuest({ executor, instance: 'worker', scriptSource: 'exit 0', nodeMajor: '24; reboot' }),
    /invalid Node major/,
  );
  assert.equal(executor.calls.length, 0);
});

test('managed Lima guest identity is observed from the guest instead of inferred from the Mac username', async () => {
  const calls = [];
  const executor = {
    async capture(command, args) {
      calls.push({ command, args });
      return { exitCode: 0, out: '/home/leeroy.guest\0leeroy\n', err: '' };
    },
  };

  const identity = await inspectManagedLimaGuestIdentity({ executor, instance: 'primary' });
  assert.deepEqual(identity, { homeDir: '/home/leeroy.guest', user: 'leeroy' });
  assert.deepEqual(calls[0].args, [
    'shell', 'primary', '--', 'sh', '-lc', 'printf "%s\\0%s" "$HOME" "$USER"',
  ]);
});

test('managed Lima guest login-manager health leaves a responsive guest unchanged', async () => {
  const executor = fakeExecutor();

  const result = await ensureManagedLimaGuestLoginManager({ executor, instance: 'primary' });

  assert.deepEqual(result, { repaired: false });
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].kind, 'capture');
  assert.match(executor.calls[0].args.at(-1), /loginctl list-sessions/);
});

test('managed Lima guest login-manager health repairs only a reproduced unresponsive logind', async () => {
  const calls = [];
  let healthChecks = 0;
  const executor = {
    async capture(command, args) {
      calls.push({ kind: 'capture', command, args });
      if (args.at(-1).includes('loginctl list-sessions')) {
        healthChecks += 1;
        return { exitCode: healthChecks === 1 ? 124 : 0, out: '', err: '' };
      }
      return { exitCode: 0, out: '', err: '' };
    },
    async run(command, args) {
      calls.push({ kind: 'run', command, args });
      return { exitCode: 0, out: '', err: '' };
    },
  };

  const result = await ensureManagedLimaGuestLoginManager({ executor, instance: 'primary' });

  assert.deepEqual(result, { repaired: true });
  const repair = calls.find((call) => call.kind === 'run');
  assert.ok(repair);
  assert.match(repair.args.at(-1), /systemctl kill --kill-whom=main --signal=KILL systemd-logind\.service/);
  assert.match(repair.args.at(-1), /systemctl start systemd-logind\.service/);
  assert.equal(healthChecks, 2);
});

test('managed Lima guest login-manager health fails when the targeted repair does not recover logind', async () => {
  const executor = {
    async capture() {
      return { exitCode: 124, out: '', err: 'timed out' };
    },
    async run() {
      return { exitCode: 0, out: '', err: '' };
    },
  };

  await assert.rejects(
    ensureManagedLimaGuestLoginManager({ executor, instance: 'primary' }),
    (error) => error.code === 'MANAGED_LIMA_GUEST_LOGIN_MANAGER_UNHEALTHY',
  );
});
