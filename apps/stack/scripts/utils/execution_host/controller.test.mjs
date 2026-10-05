import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
  executeCandidateHostCommand,
  inspectExecutionHost,
  shouldDelegateToActiveExecutionHost,
} from './controller.mjs';

const profile = {
  version: 1,
  mode: 'managed-lima',
  activation: 'candidate',
  instance: 'happier-agent-primary',
  limaHome: '/Users/example/.happier-stack/lima',
  profile: 'balanced',
  guestWorkspaceDir: '/home/example/.happier-stack/workspace',
  mirrorWorkspaceDir: '/Users/example/.happier-stack/workspace-mirror',
};

function fakeExecutor({ status = 'Stopped', doctorOk = true } = {}) {
  const calls = [];
  return {
    calls,
    async capture(command, args) {
      calls.push({ kind: 'capture', command, args });
      if (command === 'uname') return { exitCode: 0, out: 'Darwin', err: '' };
      if (args[0] === '--version') return { exitCode: 0, out: 'limactl version 2.1.0', err: '' };
      if (args[0] === 'list') {
        return {
          exitCode: 0,
          out: `${JSON.stringify({ name: profile.instance, status, vmType: 'vz', arch: 'aarch64', cpus: doctorOk ? 10 : 11, memory: 24 * 1024 ** 3, disk: 160 * 1024 ** 3, config: { mounts: [], vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } }, ssh: { forwardAgent: false }, containerd: { user: false, system: false }, portForwards: [{ guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true }] } })}\n`,
          err: '',
        };
      }
      return { exitCode: 0, out: '', err: '' };
    },
    async run(command, args) {
      calls.push({ kind: 'run', command, args });
      if (args[0] === 'start') status = 'Running';
      return { exitCode: 0 };
    },
    doctorOk,
  };
}

test('candidate host execution starts only an existing retained VM and runs in an explicit guest directory', async () => {
  const executor = fakeExecutor();
  let guestArgs;
  const boundary = { spawn(_command, args) { guestArgs = args; const child = new EventEmitter(); setImmediate(() => child.emit('close', 0, null)); return child; }, onSignal() { return () => {}; } };

  const result = await executeCandidateHostCommand({
    profile,
    executor,
    guestCwd: '/home/example/.happier-stack/workspace/dev',
    command: 'rg',
    args: ['needle', 'path with spaces'],
    boundary,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(executor.calls.filter((call) => call.kind === 'run').map((call) => call.args), [
    ['start', profile.instance],
  ]);
  assert.deepEqual(guestArgs.slice(0, 5), ['shell', '--workdir', '/home/example/.happier-stack/workspace/dev', profile.instance, '--']);
  assert.deepEqual(guestArgs.slice(-3), ['rg', 'needle', 'path with spaces']);
  assert.equal(executor.calls.some((call) => call.args.includes('create')), false);
});

test('candidate host execution refuses drift before running a command', async () => {
  const executor = fakeExecutor({ status: 'Running', doctorOk: false });
  await assert.rejects(
    executeCandidateHostCommand({
      profile,
      executor,
      guestCwd: profile.guestWorkspaceDir,
      command: 'rg',
      args: [],
    }),
    /doctor reported drift/,
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('execution host inspection is read-only and keeps candidate status explicit', async () => {
  let doctorInput;
  const result = await inspectExecutionHost({
    profile: { ...profile, diskImageFormat: 'asif' },
    doctor: async (input) => {
      doctorInput = input;
      return { ok: true, status: 'Running', drift: {} };
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.authoritative, false);
  assert.equal(result.activation, 'candidate');
  assert.equal(doctorInput.diskImageFormat, 'asif');
});

test('execution host inspection evaluates the active capacity preset', async () => {
  let doctorInput;
  await inspectExecutionHost({
    profile: {
      ...profile,
      capacity: {
        mode: 'shared',
        shared: { cpus: 10, memoryGiB: 48 },
        dedicated: { cpus: 14, memoryGiB: 72 },
      },
    },
    doctor: async (input) => {
      doctorInput = input;
      return { ok: true, status: 'Running', drift: {} };
    },
  });
  assert.deepEqual(doctorInput.resources, { cpus: 10, memoryGiB: 48 });
});

test('ordinary delegation requires active mode and stays disabled in recursion, sandbox, CI, Linux, and host-only commands', () => {
  const active = { ...profile, activation: 'active' };
  assert.equal(shouldDelegateToActiveExecutionHost({ profile, argv: ['typecheck'], platform: 'darwin', env: {} }), false);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['typecheck'], platform: 'darwin', env: {} }), true);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['dev-vm', 'status'], platform: 'darwin', env: {} }), false);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['mobile'], platform: 'darwin', env: {} }), false);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['typecheck'], platform: 'linux', env: {} }), false);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['typecheck'], platform: 'darwin', env: { CI: '1' } }), false);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['typecheck'], platform: 'darwin', env: { HAPPIER_STACK_SANDBOX_DIR: '/tmp/s' } }), false);
  assert.equal(shouldDelegateToActiveExecutionHost({ profile: active, argv: ['typecheck'], platform: 'darwin', env: { HAPPIER_STACK_EXECUTION_HOST_REENTRY: '1' } }), false);
});


test('explicit guest execution cancels its guest job before closing the host transport', async () => {
  const instance = {
    name: profile.instance, status: 'Running', vmType: 'vz', arch: 'aarch64',
    cpus: 10, memory: 24 * 1024 ** 3, disk: 160 * 1024 ** 3,
    config: { mounts: [], vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } }, ssh: { forwardAgent: false }, containerd: { user: false, system: false }, portForwards: [{ guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true }] },
  };
  let guestRunning = false;
  let signalHandler;
  let unit;
  const primary = new EventEmitter();
  // Lima can report SSH's numeric failure after the guest has been cancelled.
  primary.kill = () => { primary.emit('close', 255, null); return true; };
  // Lima and systemd are genuine OS boundaries. Real preparation, validation,
  // guest command admission and cancellation run beneath these adapters.
  const executor = {
    async capture(command, args) {
      const out = command === 'uname' ? 'Darwin' : args[0] === '--version' ? 'limactl version 2.1.0' : args[0] === 'list' ? JSON.stringify(instance) : '';
      return { exitCode: 0, out, err: '' };
    },
    async run() { guestRunning = true; return { exitCode: 0 }; },
  };
  const result = await executeCandidateHostCommand({ profile, executor, guestCwd: profile.guestWorkspaceDir, command: 'node', args: ['job.js'], boundary: {
    spawn(_command, args) {
      const child = new EventEmitter();
      if (args.includes('systemd-run')) {
        unit = args.find((arg) => arg.startsWith('--unit=')).slice(7);
        guestRunning = true;
        setImmediate(() => signalHandler('SIGINT'));
        return primary;
      }
      if (args.some((arg) => arg.includes('systemctl --user kill') && arg.includes(unit))) guestRunning = false;
      setImmediate(() => child.emit('close', 0, null));
      return child;
    },
    onSignal(handler) { signalHandler = handler; return () => {}; },
  } });
  assert.equal(guestRunning, false, 'interrupting the host must not detach a live guest job');
  assert.deepEqual(result, { exitCode: null, signal: 'SIGINT' });
});
