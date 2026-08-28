import assert from 'node:assert/strict';
import test from 'node:test';

import { runDevTargetsDoctor } from './doctor.mjs';

const targets = [
  {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    sshConfigFile: '/tmp/linux-ssh.config',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
    remoteServerPort: null,
  },
  {
    name: 'windows',
    platform: 'windows',
    ssh: 'happier-stack-windows',
    repoDir: 'C:/Users/test_qa/happier',
    cliHomeDir: 'C:/Users/test_qa/.happier/windows',
    remoteServerPort: null,
  },
];

test('dev-target doctor checks Mutagen and each target through passwordless SSH', async () => {
  const calls = [];
  const result = await runDevTargetsDoctor(
    { targets, env: { PATH: '/test/bin' } },
    {
      async runProcess(input) {
        calls.push(input);
        return { code: input.args.includes('happier-stack-windows') ? 1 : 0 };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.mutagen, { ok: true, code: 0 });
  assert.deepEqual(
    result.targets.map((target) => ({ name: target.name, ok: target.ok, code: target.code })),
    [
      { name: 'linux', ok: true, code: 0 },
      { name: 'windows', ok: false, code: 1 },
    ],
  );
  assert.deepEqual(calls[0], {
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: { PATH: '/test/bin' },
  });
  assert.deepEqual(calls[1].args.slice(0, 7), [
    '-F',
    '/tmp/linux-ssh.config',
    '-o',
    'ControlMaster=no',
    '-o',
    'BatchMode=yes',
    '-o',
  ]);
  assert.match(calls[1].args.at(-1), /command -v node/);
  const encodedPowerShell = calls[2].args.at(-1).split(' ').at(-1);
  const decodedPowerShell = Buffer.from(encodedPowerShell, 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /Get-Command node/);
  assert.match(decodedPowerShell, /Get-Command corepack/);
});

test('dev-target doctor retries one transient SSH connect timeout before accepting the target', async () => {
  let sshAttempts = 0;
  const result = await runDevTargetsDoctor(
    { targets: [targets[0]], env: {} },
    {
      async runProcess(input) {
        if (input.command === 'mutagen') return { code: 0 };
        sshAttempts += 1;
        return sshAttempts === 1
          ? { code: 255, stderr: 'ssh: connect to host 100.98.30.76 port 22: Connection timed out' }
          : { code: 0 };
      },
    },
  );

  assert.equal(sshAttempts, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets[0], {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    ok: true,
    code: 0,
  });
});

test('dev-target doctor retains a typed reason after bounded transient SSH retries are exhausted', async () => {
  let sshAttempts = 0;
  const result = await runDevTargetsDoctor(
    { targets: [targets[0]], env: {} },
    {
      async runProcess(input) {
        if (input.command === 'mutagen') return { code: 0 };
        sshAttempts += 1;
        return { code: 255, stderr: 'ssh: connect to host 100.98.30.76 port 22: Connection timed out' };
      },
    },
  );

  assert.equal(sshAttempts, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.targets[0], {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    ok: false,
    code: 255,
    diagnosticReason: 'ssh-connect-timeout',
  });
});

test('dev-target doctor does not retry SSH authentication failures', async () => {
  let sshAttempts = 0;
  const result = await runDevTargetsDoctor(
    { targets: [targets[0]], env: {} },
    {
      async runProcess(input) {
        if (input.command === 'mutagen') return { code: 0 };
        sshAttempts += 1;
        return { code: 255, stderr: 'Permission denied (publickey).' };
      },
    },
  );

  assert.equal(sshAttempts, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.targets[0], {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    ok: false,
    code: 255,
    diagnosticReason: 'ssh-authentication-failed',
  });
});

test('dev-target doctor includes read-only managed Lima lifecycle health before guest SSH health', async () => {
  const calls = [];
  const managedTarget = {
    ...targets[0],
    managedRuntime: {
      kind: 'lima',
      host: { kind: 'ssh', ssh: 'outer', sshConfigFile: '/tmp/outer.conf' },
      instance: 'worker',
      limaHome: '/Users/dev/.happier/lima',
      profile: 'worker-balanced',
    },
  };

  const result = await runDevTargetsDoctor(
    { targets: [managedTarget], env: {} },
    {
      runProcess: async () => ({ code: 0 }),
      doctorManagedRuntime: async ({ target }) => {
        calls.push(target.name);
        return { ok: false, exists: true, status: 'Stopped', drift: { creation: [], resources: [], configuration: [] } };
      },
    },
  );

  assert.deepEqual(calls, ['linux']);
  assert.equal(result.ok, false);
  assert.equal(result.targets[0].ok, false);
  assert.equal(result.targets[0].sshOk, true);
  assert.deepEqual(result.targets[0].managedRuntime, {
    ok: false,
    exists: true,
    status: 'Stopped',
    drift: { creation: [], resources: [], configuration: [] },
  });
});
