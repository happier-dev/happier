import assert from 'node:assert/strict';
import test from 'node:test';

import { mapHostCwdToGuest, prepareManagedHost, runDelegatedHstackCommand } from './delegation.mjs';

const profile = {
  version: 1,
  mode: 'managed-lima',
  activation: 'active',
  instance: 'primary',
  limaHome: '/Users/example/.happier-stack/lima',
  profile: 'balanced',
  guestWorkspaceDir: '/home/example/.happier-stack/workspace',
  mirrorWorkspaceDir: '/Users/example/.happier-stack/workspace-mirror',
};

const namedProfile = {
  ...profile,
  version: 2,
  controllerEntrypoint: '/Users/example/happier/dev/apps/stack/scripts/execution_host_bridge.mjs',
  workspaces: [
    {
      id: '0.2',
      hostSourceDir: '/Users/example/happier/remote-dev',
      hostMirrorDir: '/Users/example/.happier-stack/workspace-mirror/0.2',
      guestDir: '/home/example/.happier-stack/workspace/0.2',
    },
    {
      id: '0.3',
      stackName: 'repo-dev-a1cc5e0671',
      hostSourceDir: '/Users/example/happier/dev',
      hostMirrorDir: '/Users/example/.happier-stack/workspace-mirror/0.3',
      guestDir: '/home/example/.happier-stack/workspace/0.3',
    },
  ],
};

test('active host delegation maps only the non-authoritative mirror into the guest workspace', () => {
  assert.equal(
    mapHostCwdToGuest(profile, '/Users/example/.happier-stack/workspace-mirror/dev/apps/stack'),
    '/home/example/.happier-stack/workspace/dev/apps/stack',
  );
  assert.equal(
    mapHostCwdToGuest(profile, '/Users/example/Documents/unrelated'),
    profile.guestWorkspaceDir,
  );
  assert.equal(
    mapHostCwdToGuest(profile, '/Users/example/.happier-stack/workspace-mirror-evil/dev'),
    profile.guestWorkspaceDir,
  );
});

test('named host delegation maps source and recovery paths to the matching guest workspace and refuses unknown paths', () => {
  assert.equal(
    mapHostCwdToGuest(namedProfile, '/Users/example/happier/remote-dev/apps/stack'),
    '/home/example/.happier-stack/workspace/0.2/apps/stack',
  );
  assert.equal(
    mapHostCwdToGuest(namedProfile, '/Users/example/.happier-stack/workspace-mirror/0.3/apps/ui'),
    '/home/example/.happier-stack/workspace/0.3/apps/ui',
  );
  assert.throws(
    () => mapHostCwdToGuest(namedProfile, '/Users/example/Documents/unrelated'),
    /does not belong to a configured execution-host workspace/,
  );
  assert.throws(
    () => mapHostCwdToGuest(namedProfile, '/Users/example/happier/dev-evil'),
    /does not belong to a configured execution-host workspace/,
  );
});

test('managed host preparation mounts an enabled guest workspace after the VM is healthy', async () => {
  const calls = [];
  const mountedProfile = {
    ...namedProfile,
    autoMount: true,
    hostMountDir: '/Users/example/.happier-stack/workspace',
  };
  await prepareManagedHost(mountedProfile, {
    workspaceId: '0.3',
    executor: { kind: 'test-executor' },
    start: async ({ instance }) => { calls.push(['start', instance]); },
    doctor: async ({ instance, profileName }) => {
      calls.push(['doctor', instance, profileName]);
      return { ok: true };
    },
    reconcileServiceTunnel: async ({ profile: received, workspaceId, executor: receivedExecutor }) => {
      calls.push(['forward', received.instance, workspaceId, receivedExecutor]);
    },
    mount: async ({ profile: received, mountDir, executor: receivedExecutor }) => {
      calls.push(['mount', received.instance, mountDir, receivedExecutor]);
    },
  });

  assert.deepEqual(calls, [
    ['start', 'primary'],
    ['doctor', 'primary', 'balanced'],
    ['forward', 'primary', '0.3', { kind: 'test-executor' }],
    ['mount', 'primary', '/Users/example/.happier-stack/workspace', { kind: 'test-executor' }],
  ]);
});

test('named host preparation reconciles only the delegated workspace service tunnel before guest execution', async () => {
  const calls = [];
  await prepareManagedHost(namedProfile, {
    workspaceId: '0.3',
    stackName: 'repo-dev-a1cc5e0671',
    executor: { kind: 'test-executor' },
    start: async () => {},
    doctor: async () => ({ ok: true }),
    reconcileServiceTunnel: async ({ workspaceId, stackName }) => { calls.push([workspaceId, stackName]); },
  });
  assert.deepEqual(calls, [['0.3', 'repo-dev-a1cc5e0671']]);
});

test('managed host preparation warns but delegates commands that do not require the host service tunnel', async () => {
  const calls = [];
  const warnings = [];
  await prepareManagedHost(namedProfile, {
    workspaceId: '0.3',
    stackName: 'repo-dev-a1cc5e0671',
    requiresServiceTunnel: false,
    executor: { kind: 'test-executor' },
    start: async () => { calls.push('start'); },
    doctor: async () => { calls.push('doctor'); return { ok: true }; },
    reconcileServiceTunnel: async () => {
      calls.push('tunnel');
      throw new Error('[dev-vm] unable to verify whether TCP port 53288 is available');
    },
    mount: async () => { calls.push('mount'); },
    reportWarning: (message) => { warnings.push(message); },
  });

  assert.deepEqual(calls, ['start', 'doctor', 'tunnel']);
  assert.deepEqual(warnings, [
    '[dev-vm] host service tunnel could not be reconciled; continuing delegated command without host service access: [dev-vm] unable to verify whether TCP port 53288 is available',
  ]);
});

test('managed host preparation keeps service-tunnel failures fatal unless the caller classifies it as optional', async () => {
  await assert.rejects(
    prepareManagedHost(namedProfile, {
      workspaceId: '0.3',
      stackName: 'repo-dev-a1cc5e0671',
      executor: { kind: 'test-executor' },
      start: async () => {},
      doctor: async () => ({ ok: true }),
      reconcileServiceTunnel: async () => {
        throw new Error('[dev-vm] unable to verify whether TCP port 53288 is available');
      },
    }),
    /unable to verify whether TCP port 53288 is available/,
  );
});

test('delegation prepares the selected Stack tunnel before dispatching a stack-scoped command', async () => {
  const preparations = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };

  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['dev-targets', 'list', '--stack=repo-dev-a1cc5e0671'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin' },
    prepare: async (_profile, options) => { preparations.push(options); },
    boundary: {
      spawn() { return child; },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(preparations, [{
    workspaceId: '0.3',
    stackName: 'repo-dev-a1cc5e0671',
    requiresServiceTunnel: false,
  }]);
});

test('active Mac dev-target sync-service delegation uses the mapped guest repo-local owner', async () => {
  const preparations = [];
  const spawns = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };

  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['dev-targets', 'sync-service', 'start'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin', HAPPIER_STACK_STACK: 'repo-host-stale' },
    prepare: async (_profile, options) => { preparations.push(options); },
    boundary: {
      spawn(command, args) {
        spawns.push({ command, args });
        return child;
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(preparations, [{
    workspaceId: '0.3',
    stackName: 'repo-dev-a1cc5e0671',
    requiresServiceTunnel: false,
  }]);
  assert.deepEqual(spawns[0].args.slice(-5), [
    'node',
    '/home/example/.happier-stack/workspace/0.3/apps/stack/scripts/repo_local.mjs',
    'dev-targets',
    'sync-service',
    'start',
  ]);
});

test('delegation uses the workspace default Stack when repo-local startup has no explicit Stack selector', async () => {
  const preparations = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };
  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['tui'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin' },
    prepare: async (_profile, options) => { preparations.push(options); },
    reconcileAfterStart: async () => ({ status: 'running' }),
    boundary: {
      spawn() { return child; },
      onSignal() { return () => {}; },
    },
  });
  assert.equal(preparations[0].stackName, 'repo-dev-a1cc5e0671');
  assert.equal(preparations[0].requiresServiceTunnel, true);
});

test('delegation gives an explicit TUI Stack selection precedence over ambient Stack state', async () => {
  const preparations = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };

  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['tui', 'stack', 'dev', 'repo-dev-a1cc5e0671'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin', HAPPIER_STACK_STACK: 'ambient-stack' },
    prepare: async (_profile, options) => { preparations.push(options); },
    reconcileAfterStart: async () => ({ status: 'running' }),
    boundary: {
      spawn() { return child; },
      onSignal() { return () => {}; },
    },
  });

  assert.equal(preparations[0].stackName, 'repo-dev-a1cc5e0671');
});

test('named delegation keeps host preparation bound to its mapped guest Stack over ambient host state', async () => {
  const preparations = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };

  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['typecheck'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin', HAPPIER_STACK_STACK: 'ambient-stack' },
    prepare: async (_profile, options) => { preparations.push(options); },
    boundary: {
      spawn() { return child; },
      onSignal() { return () => {}; },
    },
  });

  assert.equal(preparations[0].stackName, 'repo-dev-a1cc5e0671');
});

test('managed host preparation preserves delegation during the known Lima service-forward cutover', async () => {
  const calls = [];
  await prepareManagedHost(namedProfile, {
    workspaceId: '0.3',
    executor: { kind: 'test-executor' },
    start: async () => {},
    doctor: async () => ({
      ok: false,
      status: 'Running',
      drift: {
        creation: [],
        resources: [],
        configuration: [{
          field: 'portForwards',
          expected: [],
          actual: [
            {
              guestIPMustBeZero: false,
              guestIP: '127.0.0.1',
              guestPortRange: [52005, 54004],
              hostIP: '0.0.0.0',
              hostPortRange: [52005, 54004],
              proto: 'any',
            },
            {
              guestIPMustBeZero: false,
              guestIP: '127.0.0.1',
              guestPortRange: [18081, 20080],
              hostIP: '0.0.0.0',
              hostPortRange: [18081, 20080],
              proto: 'any',
            },
            {
              guestIPMustBeZero: false,
              guestIP: '0.0.0.0',
              guestPortRange: [1, 65535],
              hostIP: '127.0.0.1',
              hostPortRange: [1, 65535],
              proto: 'any',
              ignore: true,
            },
          ],
        }],
      },
      guestLoginManager: { ok: true },
      guestToolchain: { ok: true },
    }),
    reconcileServiceTunnel: async () => { calls.push('forward'); },
  });

  assert.deepEqual(calls, []);
});

test('delegation invokes the selected guest repo-local entrypoint and protects its TUI control plane', async () => {
  const spawns = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };
  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['tui', '--json'],
    cwd: '/Users/example/happier/remote-dev',
    prepare: async () => {},
    guestInvocation: {
      command: 'node',
      args: ['/home/example/.happier-stack/workspace/0.2/apps/stack/scripts/repo_local.mjs'],
    },
    boundary: {
      spawn(command, args, options) {
        spawns.push({ command, args, options });
        return child;
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(spawns[0].args.slice(-5), [
    'node',
    '/home/example/.happier-stack/workspace/0.2/apps/stack/scripts/repo_local.mjs',
    'tui',
    '--json',
    '--rescue',
  ]);
});

test('delegated Stack startup reconciles host service tunnels after spawning the guest process', async () => {
  const calls = [];
  let closeChild;
  const child = {
    once(event, listener) {
      if (event === 'close') closeChild = () => listener(0, null);
      return this;
    },
    kill() {},
  };
  const running = runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['tui', 'stack', 'dev', 'repo-dev-a1cc5e0671'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin' },
    prepare: async () => { calls.push('prepare'); },
    reconcileAfterStart: ({ workspaceId, stackName, signal }) => new Promise((resolve) => {
      calls.push(['reconcile', workspaceId, stackName, signal.aborted]);
      signal.addEventListener('abort', () => {
        calls.push('reconciliation-cancelled');
        resolve({ status: 'cancelled' });
      }, { once: true });
    }),
    boundary: {
      spawn() {
        calls.push('spawn');
        return child;
      },
      onSignal() { return () => {}; },
    },
  });

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(calls, [
    'prepare',
    'spawn',
    ['reconcile', '0.3', 'repo-dev-a1cc5e0671', false],
  ]);
  closeChild();
  assert.deepEqual(await running, { exitCode: 0, signal: null });
  assert.equal(calls.at(-1), 'reconciliation-cancelled');
});

test('active VM delegation enables the existing TUI control-plane rescue priority by default', async () => {
  const spawns = [];
  const child = {
    once(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0, null));
      return this;
    },
    kill() {},
  };
  await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['tui', 'dev', '--mobile'],
    cwd: '/Users/example/happier/dev',
    prepare: async () => {},
    boundary: {
      spawn(command, args, options) {
        spawns.push({ command, args, options });
        return child;
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(spawns[0].args.slice(-4), ['tui', 'dev', '--mobile', '--rescue']);
});

test('active named host delegation uses the selected guest repo-local entrypoint without requiring a global install', async () => {
  const spawns = [];
  const listeners = new Map();
  const child = {
    once(event, listener) {
      listeners.set(event, listener);
      if (event === 'close') queueMicrotask(() => listener(23, null));
      return this;
    },
    kill() {},
  };
  const result = await runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['typecheck', 'path with spaces', "apostrophe's"],
    cwd: '/Users/example/happier/dev',
    env: {
      PATH: '/usr/bin',
      HAPPIER_STACK_STACK: 'repo-dev-a1cc5e0671',
      HAPPIER_STACK_ENV_FILE: '/Users/example/.happier/stacks/repo-dev-a1cc5e0671/env',
    },
    prepare: async () => {},
    boundary: {
      spawn(command, args, options) {
        spawns.push({ command, args, options });
        return child;
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(result, { exitCode: 23, signal: null });
  assert.equal(spawns[0].command, 'limactl');
  assert.deepEqual(spawns[0].args, [
    'shell', '--workdir', '/home/example/.happier-stack/workspace/0.3', 'primary', '--',
    'env',
    'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1',
    'HAPPIER_STACK_INVOKED_CWD=/home/example/.happier-stack/workspace/0.3',
    'HAPPIER_STACK_STACK=repo-dev-a1cc5e0671',
    'node', '/home/example/.happier-stack/workspace/0.3/apps/stack/scripts/repo_local.mjs',
    'typecheck', 'path with spaces', "apostrophe's",
  ]);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.env.LIMA_HOME, profile.limaHome);
  assert.ok(
    !spawns[0].args.some((arg) => arg.includes('/Users/example/.happier/stacks')),
    'host filesystem paths must not leak into the guest environment',
  );
});
