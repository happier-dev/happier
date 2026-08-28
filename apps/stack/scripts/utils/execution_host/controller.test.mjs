import assert from 'node:assert/strict';
import test from 'node:test';

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
      if (args[0] === 'list') {
        return {
          exitCode: 0,
          out: `${JSON.stringify({ name: profile.instance, status })}\n`,
          err: '',
        };
      }
      return { exitCode: 0, out: '', err: '' };
    },
    async run(command, args) {
      calls.push({ kind: 'run', command, args });
      return { exitCode: 0 };
    },
    doctorOk,
  };
}

test('candidate host execution starts only an existing retained VM and runs in an explicit guest directory', async () => {
  const executor = fakeExecutor();

  const result = await executeCandidateHostCommand({
    profile,
    executor,
    guestCwd: '/home/example/.happier-stack/workspace/dev',
    command: 'rg',
    args: ['needle', 'path with spaces'],
    doctor: async () => ({ ok: true }),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(executor.calls.filter((call) => call.kind === 'run').map((call) => call.args), [
    ['start', profile.instance],
    [
      'shell', '--workdir', '/home/example/.happier-stack/workspace/dev',
      profile.instance, '--', 'rg', 'needle', 'path with spaces',
    ],
  ]);
  assert.equal(executor.calls.some((call) => call.args.includes('create')), false);
});

test('candidate host execution refuses drift before running a command', async () => {
  const executor = fakeExecutor({ status: 'Running' });
  await assert.rejects(
    executeCandidateHostCommand({
      profile,
      executor,
      guestCwd: profile.guestWorkspaceDir,
      command: 'rg',
      args: [],
      doctor: async () => ({ ok: false, drift: { resources: [{ field: 'memory' }] } }),
    }),
    /doctor reported drift/,
  );
  assert.equal(executor.calls.some((call) => call.kind === 'run'), false);
});

test('execution host inspection is read-only and keeps candidate status explicit', async () => {
  const result = await inspectExecutionHost({
    profile,
    doctor: async () => ({ ok: true, status: 'Running', drift: {} }),
  });
  assert.equal(result.configured, true);
  assert.equal(result.authoritative, false);
  assert.equal(result.activation, 'candidate');
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
