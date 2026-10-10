import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runCommandCapture } from '../../testkit/core/run_node_capture.mjs';
import { resolveDevTargetMutagenRuntime } from '../dev_targets/mutagen_runtime.mjs';
import { runExecutionHostBridge } from './bridge.mjs';

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

async function sshFixture(t) {
  const fixture = await createTempFixture(t);
  const env = { HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), PATH: process.env.PATH };
  const selected = { ...namedProfile, mode: 'ssh-dev-target', sshPrimary: { targetName: 'nl2', stackName: 'lane' } };
  const target = { name: 'nl2', platform: 'posix', ssh: 'enrolled-nl2',
    sshConfigFile: fixture.path('enrolled-config'), repoDir: namedProfile.workspaces[1].guestDir,
    cliHomeDir: '/home/example/.happier/cli' };
  const stackBaseDir = fixture.path('stacks', 'lane');
  await mkdir(stackBaseDir, { recursive: true });
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target] }));
  return { fixture, env, selected, target, stackBaseDir };
}

test('SSH primary delegates TUI with enrolled transport, PTY, mapped cwd and the Lima environment rules', async t => {
  const { fixture, env, selected, target, stackBaseDir } = await sshFixture(t);
  const { opensshDir } = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  await mkdir(opensshDir, { recursive: true });
  const sharedConfig = join(opensshDir, 'config');
  await writeFile(sharedConfig, '# boundary fixture');
  const spawns = [];
  const probes = [];
  const result = await runDelegatedHstackCommand({ profile: selected, argv: ['tui', 'literal $(input)', "quote'arg"],
    cwd: '/Users/example/happier/dev/apps/stack', env: { ...env, PRIVATE_TOKEN: 'must-stay-local' },
    boundary: {
      async capture(command, args) {
        probes.push({ command, args });
        return { exitCode: args.at(-1).includes('HAPPIER_STACK_REPO_DIR') ? 3 : 0, out: '', err: '' };
      },
      spawn(command, args, options) {
        spawns.push({ command, args, options });
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 7, null));
        return child;
      }, onSignal() { return () => {}; },
    } });
  assert.deepEqual(result, { exitCode: 7, signal: null });
  assert.ok(probes.some(probe => probe.args.at(-1).includes('HAPPIER_STACK_REPO_DIR')),
    'SSH delegation must discover declared Stack services through the same primary transport');
  for (const workspace of selected.workspaces) {
    assert.ok(probes.some(probe => probe.args.at(-1).includes('HAPPIER_STACK_REPO_DIR')
      && probe.args.at(-1).includes(workspace.guestDir)), `must reconcile workspace ${workspace.id}`);
  }
  assert.ok(probes.every(probe => probe.args.includes('-T')));
  assert.ok(probes.every(probe => probe.args.includes(sharedConfig)));
  assert.equal(spawns.length, 1);
  const invocation = spawns[0];
  assert.equal(invocation.command, 'ssh');
  assert.ok(invocation.args.includes('-tt'));
  assert.ok(invocation.args.includes(sharedConfig));
  assert.ok(invocation.args.includes(target.ssh));
  assert.equal(invocation.options.stdio, 'inherit');
  const remote = invocation.args.at(-1);
  // Parse the transport's real shell argument into its login-shell body. This
  // OS boundary evaluates quoting, including hostile-looking literal input.
  const parsed = await runCommandCapture('bash', ['-c', `function bash() { printf '%s' "$2"; }; ${remote.replace(/^exec /, '')}`]);
  assert.equal(parsed.code, 0, parsed.stderr);
  assert.match(parsed.stdout, /HAPPIER_STACK_INVOKED_CWD=\/home\/example\/\.happier-stack\/workspace\/0\.3\/apps\/stack/);
  assert.match(parsed.stdout, /HAPPIER_STACK_EXECUTION_HOST_REENTRY=1/);
  assert.match(parsed.stdout, /HAPPIER_STACK_STACK=repo-dev-a1cc5e0671/);
  assert.match(parsed.stdout, /repo_local\.mjs/);
  assert.match(parsed.stdout, /--rescue/);
  assert.doesNotMatch(remote, /must-stay-local/);
  const literal = 'literal $(input)';
  // Inspect argv without executing the selected runtime or touching a Stack.
  const inspect = parsed.stdout.replace(/exec 'systemd-run'/, "function systemd_run() { printf '%s\\n' \"$@\"; }; systemd_run");
  const directory = fixture.path('remote');
  await mkdir(directory);
  const evaluated = await runCommandCapture('bash', ['-c', inspect.replace(/cd -- '[^']*'/, `cd -- '${directory}'`)]);
  assert.equal(evaluated.code, 0, evaluated.stderr);
  assert.ok(evaluated.stdout.split('\n').includes(literal));
  assert.ok(evaluated.stdout.split('\n').includes("quote'arg"));
});

test('unreachable SSH primary refuses before command dispatch with no local fallback', async t => {
  const { env, selected } = await sshFixture(t);
  const spawns = [];
  await assert.rejects(runDelegatedHstackCommand({ profile: selected, argv: ['tui'],
    cwd: '/Users/example/happier/dev', env, boundary: {
      async capture() { return { exitCode: 255, err: 'ssh: connect to host fixture port 22: Connection refused' }; },
      spawn(...args) { spawns.push(args); throw new Error('payload must not start'); },
      onSignal() { return () => {}; },
    } }), /SSH primary nl2.*unreachable/);
  assert.deepEqual(spawns, []);
});

test('SSH cancellation uses the same scope and enrolled transport before closing the foreground SSH child', async t => {
  const { env, selected, target } = await sshFixture(t);
  const spawns = [];
  const child = new EventEmitter();
  child.kill = signal => { child.emit('close', null, signal); return true; };
  let interrupt;
  const result = await runDelegatedHstackCommand({ profile: selected, argv: ['tui'],
    cwd: '/Users/example/happier/dev', env, boundary: {
      async capture(_command, args) { return { exitCode: args.at(-1).includes('HAPPIER_STACK_REPO_DIR') ? 3 : 0 }; },
      spawn(command, args) {
        spawns.push({ command, args });
        if (spawns.length === 1) { setImmediate(() => interrupt('SIGINT')); return child; }
        const cancellation = new EventEmitter();
        setImmediate(() => cancellation.emit('close', 0, null));
        return cancellation;
      }, onSignal(handler) { interrupt = handler; return () => {}; },
    } });
  assert.deepEqual(result, { exitCode: null, signal: 'SIGINT' });
  assert.equal(spawns.length, 2);
  const unit = spawns[0].args.at(-1).match(/happier-execution-host-[a-z0-9-]+\.scope/)[0];
  assert.match(spawns[1].args.at(-1), new RegExp(unit.replaceAll('.', '\\.')));
  assert.ok(spawns[1].args.includes('-T'));
  assert.ok(spawns[1].args.includes(target.sshConfigFile));
  assert.ok(spawns[1].args.includes(target.ssh));
});

test('predecessor bridge uses SSH for workspace 0.2 and keeps native commands on the Mac', async t => {
  const { env, selected } = await sshFixture(t);
  const spawns = [];
  const boundary = {
    async capture(_command, args) { return { exitCode: args.at(-1).includes('HAPPIER_STACK_REPO_DIR') ? 3 : 0 }; },
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    }, onSignal() { return () => {}; },
  };
  const input = { profile: selected, workspaceId: '0.2',
    localEntrypoint: '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    cwd: '/Users/example/happier/remote-dev', env, platform: 'darwin', boundary };
  const delegated = await runExecutionHostBridge({ ...input, argv: ['tui'] });
  assert.equal(delegated.delegated, true);
  assert.equal(spawns[0].command, 'ssh');
  assert.match(spawns[0].args.at(-1), /workspace\/0\.2\/apps\/stack\/scripts\/repo_local\.mjs/);
  const native = await runExecutionHostBridge({ ...input, argv: ['mobile'] });
  assert.equal(native.delegated, false);
  assert.equal(spawns[1].command, process.execPath);
  assert.deepEqual(spawns[1].args, [input.localEntrypoint, 'mobile']);
  assert.equal(spawns[1].options.env.HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY, '1');
});

test('dispatched SSH failure is returned once without replay or fallback', async t => {
  const { env, selected } = await sshFixture(t);
  let launches = 0;
  const warnings = [];
  const result = await runDelegatedHstackCommand({ profile: selected, argv: ['tui'],
    cwd: '/Users/example/happier/dev', env, boundary: {
      async capture(_command, args) { return { exitCode: args.at(-1).includes('HAPPIER_STACK_REPO_DIR') ? 3 : 0 }; },
      spawn(command) {
        launches += 1;
        assert.equal(command, 'ssh');
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 255, null));
        return child;
      }, onSignal() { return () => {}; }, reportWarning(message) { warnings.push(message); },
    } });
  assert.equal(result.exitCode, 255);
  assert.equal(launches, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no replay or local fallback/);
});

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
    diskImageFormat: 'asif',
    capacity: {
      mode: 'shared',
      shared: { cpus: 10, memoryGiB: 48 },
      dedicated: { cpus: 14, memoryGiB: 72 },
    },
    autoMount: true,
    hostMountDir: '/Users/example/.happier-stack/workspace',
  };
  await prepareManagedHost(mountedProfile, {
    workspaceId: '0.3',
    executor: { kind: 'test-executor' },
    start: async ({ instance }) => { calls.push(['start', instance]); },
    doctor: async ({ instance, profileName, diskImageFormat, resources }) => {
      calls.push(['doctor', instance, profileName, diskImageFormat, resources]);
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
    ['doctor', 'primary', 'balanced', 'asif', { cpus: 10, memoryGiB: 48 }],
    ['forward', 'primary', '0.3', { kind: 'test-executor' }],
    ['mount', 'primary', '/Users/example/.happier-stack/workspace', { kind: 'test-executor' }],
  ]);
});

test('named host preparation reconciles only the delegated workspace service tunnel before guest execution', async () => {
  const calls = [];
  const preparation = await prepareManagedHost(namedProfile, {
    workspaceId: '0.3',
    stackName: 'repo-dev-a1cc5e0671',
    executor: { kind: 'test-executor' },
    start: async () => {},
    doctor: async () => ({ ok: true }),
    reconcileServiceTunnel: async ({ workspaceId, stackName }) => {
      calls.push([workspaceId, stackName]);
      return { runtimeStartedAt: '2026-08-28T18:23:59.000Z' };
    },
  });
  assert.deepEqual(calls, [['0.3', 'repo-dev-a1cc5e0671']]);
  assert.deepEqual(preparation, {
    serviceTunnelRuntimeStartedAt: '2026-08-28T18:23:59.000Z',
  });
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
    prepare: async () => {
      calls.push('prepare');
      return { serviceTunnelRuntimeStartedAt: '2026-08-28T18:23:59.000Z' };
    },
    reconcileAfterStart: ({ workspaceId, stackName, signal, previousRuntimeStartedAt }) => new Promise((resolve) => {
      calls.push(['reconcile', workspaceId, stackName, previousRuntimeStartedAt, signal.aborted]);
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
    ['reconcile', '0.3', 'repo-dev-a1cc5e0671', '2026-08-28T18:23:59.000Z', false],
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
  const delegatedScopeUnit = spawns[0].args.find((arg) => arg.startsWith('--unit=happier-execution-host-'));
  assert.match(delegatedScopeUnit ?? '', /^--unit=happier-execution-host-[a-z0-9-]+\.scope$/);
  assert.deepEqual(spawns[0].args, [
    'shell', '--workdir', '/home/example/.happier-stack/workspace/0.3', 'primary', '--',
    'systemd-run', '--user', '--scope', '--quiet', delegatedScopeUnit, '--',
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

test('execution-host delegation cancels the complete guest scope when the host is interrupted', async () => {
  const spawns = [];
  const primarySignals = [];
  let signalHandler;
  let closePrimary;
  let closeCancellation;
  const primary = {
    once(event, listener) {
      if (event === 'close') closePrimary = listener;
      return this;
    },
    kill(signal) {
      primarySignals.push(signal);
      queueMicrotask(() => closePrimary?.(null, signal));
    },
  };
  const cancelled = {
    once(event, listener) {
      if (event === 'close') closeCancellation = listener;
      return this;
    },
  };

  const running = runDelegatedHstackCommand({
    profile: namedProfile,
    argv: ['dev-targets', 'exec', 'mac2-linux', '--', 'vitest', 'run'],
    cwd: '/Users/example/happier/dev',
    env: { PATH: '/usr/bin' },
    prepare: async () => {},
    boundary: {
      spawn(command, args, options) {
        spawns.push({ command, args, options });
        return spawns.length === 1 ? primary : cancelled;
      },
      onSignal(handler) {
        signalHandler = handler;
        return () => {};
      },
    },
  });

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  signalHandler('SIGINT');
  assert.deepEqual(primarySignals, [], 'the host must not tear down the primary transport before guest cleanup finishes');
  closeCancellation(0, null);
  assert.deepEqual(await running, { exitCode: null, signal: 'SIGINT' });
  assert.deepEqual(primarySignals, ['SIGINT']);
  assert.equal(spawns.length, 2);
  const delegatedUnit = spawns[0].args.find((arg) => String(arg).startsWith('--unit='));
  assert.match(delegatedUnit, /^--unit=happier-execution-host-[a-z0-9-]+\.scope$/);
  assert.ok(spawns[0].args.includes('systemd-run'));
  assert.ok(spawns[1].args.some((arg) => String(arg).includes('systemctl --user kill')));
  assert.ok(spawns[1].args.some((arg) => String(arg).includes(delegatedUnit.slice('--unit='.length))));
  assert.ok(spawns[1].args.some((arg) => String(arg).includes('-lt 150')));
});

test('active host preparation retains a running VM with pending resource or toolchain updates', async (t) => {
  for (const [name, changes] of [
    ['toolchain', { guestToolchain: { ok: false, error: 'Bun 1.4.2 is required in the managed Lima guest' } }],
    ['capacity', { drift: { creation: [], resources: [{ field: 'memory', expected: 72, actual: 48 }], configuration: [] } }],
  ]) {
    await t.test(name, async () => {
      const warnings = [];
      const calls = [];
      await prepareManagedHost({ ...namedProfile, autoMount: true }, {
        workspaceId: '0.2',
        executor: { kind: 'test-executor' },
        start: async () => { calls.push('start'); },
        doctor: async () => ({
          ok: false, exists: true, status: 'Running',
          drift: { creation: [], resources: [], configuration: [] },
          guestLoginManager: { ok: true }, guestToolchain: { ok: true }, ...changes,
        }),
        reconcileServiceTunnel: async () => { calls.push('tunnel'); },
        mount: async () => { calls.push('mount'); },
        reportWarning: (message) => warnings.push(message),
      });
      assert.deepEqual(calls, ['start', 'tunnel', 'mount']);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], name === 'toolchain' ? /Bun 1\.4\.2/ : /memory/);
    });
  }
});

test('managed host preparation still rejects unavailable, unsafe, and candidate hosts', async (t) => {
  for (const [name, changes, activation] of [
    ['candidate', {}, 'candidate'],
    ['missing', { exists: false }],
    ['unknown failure', { guestToolchain: { ok: true } }],
    ['stopped', { status: 'Stopped' }],
    ['login failure', { guestLoginManager: { ok: false, error: 'login unavailable' } }],
    ['creation drift', { drift: { creation: [{ field: 'arch' }], resources: [], configuration: [] } }],
    ['unsafe configuration', { drift: { creation: [], resources: [], configuration: [{ field: 'ssh.forwardAgent' }] } }],
  ]) {
    await t.test(name, async () => {
      let reachedGuest = false;
      await assert.rejects(prepareManagedHost({ ...namedProfile, activation: activation ?? 'active' }, {
        executor: { kind: 'test-executor' }, start: async () => {},
        doctor: async () => ({
          ok: false, exists: true, status: 'Running',
          drift: { creation: [], resources: [], configuration: [] },
          guestLoginManager: { ok: true },
          guestToolchain: { ok: false, error: 'Bun update pending' }, ...changes,
        }),
        reconcileServiceTunnel: async () => { reachedGuest = true; },
      }), /doctor reported drift/);
      assert.equal(reachedGuest, false);
    });
  }
});
