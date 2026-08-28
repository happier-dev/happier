import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureManagedLimaGuestLoginManager,
  inspectManagedLimaGuestIdentity,
  inspectManagedLimaGuestToolchain,
  provisionManagedLimaGuest,
  restartManagedLimaGuestAgent,
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
  assert.ok(provision.args.includes('HAPPIER_PROVISION_MUTAGEN_VERSION=0.18.1'));
  assert.ok(provision.args.includes('HAPPIER_PROVISION_AGENT_BROWSER_VERSION=0.34.0'));
  assert.ok(provision.args.includes('HAPPIER_PROVISION_PLAYWRIGHT_VERSION=1.58.2'));
  assert.ok(provision.args.includes('HAPPIER_PROVISION_BUN_VERSION=1.3.5'));
  assert.deepEqual(provision.args.slice(-4), ['bash', '-s', '--', '--profile=happier']);
  assert.equal(executor.calls.some((call) => call.args.includes('delete')), false);
  assert.equal(executor.calls.at(-1).kind, 'run');
  assert.match(executor.calls.at(-1).args.at(-1), new RegExp(`${result.version}\\.ready`));
});

test('managed Lima guest provisioning makes the pinned Bun version part of readiness identity', async () => {
  const scriptSource = '#!/usr/bin/env bash\necho provisioned\n';
  const firstExecutor = fakeExecutor();
  const secondExecutor = fakeExecutor();

  const first = await provisionManagedLimaGuest({
    executor: firstExecutor,
    instance: 'primary',
    scriptSource,
    bunVersion: '1.3.5',
  });
  const second = await provisionManagedLimaGuest({
    executor: secondExecutor,
    instance: 'primary',
    scriptSource,
    bunVersion: '1.3.6',
  });

  assert.notEqual(first.version, second.version, 'a Bun version change must invalidate the readiness marker');
  for (const [executor, version] of [[firstExecutor, '1.3.5'], [secondExecutor, '1.3.6']]) {
    const provision = executor.calls.find((call) => call.kind === 'run' && call.options.input === scriptSource);
    assert.ok(provision);
    assert.ok(provision.args.includes(`HAPPIER_PROVISION_BUN_VERSION=${version}`));
  }
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

test('managed Lima guest provisioning repairs drifted tooling even when the readiness marker remains', async () => {
  const calls = [];
  let toolchainChecks = 0;
  const executor = {
    async capture(command, args, options = {}) {
      calls.push({ kind: 'capture', command, args, options });
      if (args[3] === 'test' && args[4] === '-f') return { exitCode: 0, out: '', err: '' };
      if (args.at(-1).includes('command -v node')) {
        toolchainChecks += 1;
        return toolchainChecks === 1
          ? { exitCode: 127, out: '', err: 'agent-browser is required in the managed Lima guest' }
          : { exitCode: 0, out: '', err: '' };
      }
      return { exitCode: 0, out: '', err: '' };
    },
    async run(command, args, options = {}) {
      calls.push({ kind: 'run', command, args, options });
      return { exitCode: 0, out: '', err: '' };
    },
  };

  const result = await provisionManagedLimaGuest({
    executor,
    instance: 'primary',
    scriptSource: '#!/usr/bin/env bash\necho provisioned\n',
  });

  assert.equal(result.changed, true);
  assert.equal(toolchainChecks, 2);
  assert.ok(calls.some((call) => call.kind === 'run' && call.options.input === '#!/usr/bin/env bash\necho provisioned\n'));
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

test('managed Lima guest toolchain health requires the managed runtime, sandbox, and browser prerequisites', async () => {
  const calls = [];
  const executor = {
    async capture(command, args) {
      calls.push({ command, args });
      return { exitCode: 127, out: '', err: 'ripgrep (rg) is required in the managed Lima guest' };
    },
  };

  const result = await inspectManagedLimaGuestToolchain({ executor, instance: 'primary' });

  assert.deepEqual(result, {
    ok: false,
    error: 'ripgrep (rg) is required in the managed Lima guest',
  });
  assert.match(calls[0].args.at(-1), /command -v node/);
  assert.match(calls[0].args.at(-1), /command -v corepack/);
  assert.match(calls[0].args.at(-1), /command -v rg/);
  assert.match(calls[0].args.at(-1), /command -v mutagen/);
  assert.match(calls[0].args.at(-1), /command -v bwrap/);
  assert.match(calls[0].args.at(-1), /command -v agent-browser/);
  assert.match(calls[0].args.at(-1), /command -v bun/);
  assert.match(calls[0].args.at(-1), /rg --version/);
  assert.match(calls[0].args.at(-1), /bun --version \| grep -Fx '1\.3\.5'/);
  assert.match(calls[0].args.at(-1), /happier-bwrap AppArmor profile/);
  assert.match(calls[0].args.at(-1), /userns/);
  assert.match(calls[0].args.at(-1), /headless_shell/);
});

test('managed Lima guest toolchain health uses noninteractive privilege for the AppArmor profile listing', async () => {
  const calls = [];
  const executor = {
    async capture(command, args) {
      calls.push({ command, args });
      const healthCommand = args.at(-1);
      if (healthCommand.includes('/sys/kernel/security/apparmor/profiles')) {
        return healthCommand.includes('sudo -n grep')
          ? { exitCode: 0, out: '', err: '' }
          : { exitCode: 13, out: '', err: 'grep: Permission denied' };
      }
      return { exitCode: 0, out: '', err: '' };
    },
  };

  const result = await inspectManagedLimaGuestToolchain({ executor, instance: 'primary' });

  assert.deepEqual(result, { ok: true, error: null });
  assert.match(
    calls[0].args.at(-1),
    /if \[ -r \/sys\/kernel\/security\/apparmor\/profiles \]; then sudo -n grep -Eq .* \/sys\/kernel\/security\/apparmor\/profiles/,
  );
  assert.match(
    calls[0].args.at(-1),
    /else echo "happier-bwrap AppArmor profile listing is unavailable" >&2; exit 1; fi/,
  );
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

test('managed Lima guest-agent forwarding repair force-recycles a wedged service and fails closed when it does not recover', async () => {
  const calls = [];
  const executor = {
    async capture(command, args) {
      calls.push({ kind: 'capture', command, args });
      return { exitCode: 3, out: '', err: 'inactive' };
    },
    async run(command, args) {
      calls.push({ kind: 'run', command, args });
      return { exitCode: 0, out: '', err: '' };
    },
  };

  await assert.rejects(
    restartManagedLimaGuestAgent({ executor, instance: 'primary' }),
    (error) => error.code === 'MANAGED_LIMA_GUEST_AGENT_UNHEALTHY',
  );
  assert.match(calls[0].args.at(-1), /systemctl kill -s SIGKILL lima-guestagent\.service/);
  assert.match(calls[0].args.at(-1), /systemctl reset-failed lima-guestagent\.service/);
  assert.match(calls[0].args.at(-1), /systemctl start lima-guestagent\.service/);
  assert.doesNotMatch(calls[0].args.at(-1), /systemctl restart/);
  assert.match(calls[1].args.at(-1), /systemctl is-active --quiet lima-guestagent\.service/);
});
