import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  inspectExecutionHostWorkspaceMount,
  mountExecutionHostWorkspace,
  resolveExecutionHostWorkspaceMount,
  superviseExecutionHostWorkspaceMount,
  unmountExecutionHostWorkspace,
} from './workspace_mount.mjs';

function profile(limaHome) {
  return {
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'happier-agent-primary',
    limaHome,
    profile: 'balanced',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: '/Users/leeroy/.happier-stack/workspace-mirror',
  };
}

test('workspace mount defaults to the Mac-side guest-home mount path', () => {
  const resolved = resolveExecutionHostWorkspaceMount(
    profile('/Users/leeroy/.happier-stack/lima'),
    { HAPPIER_STACK_HOME_DIR: '/Users/leeroy/.happier-stack' },
  );

  assert.equal(resolved.mountDir, '/Users/leeroy/.happier-stack/vm-home');
});

test('SSH primary mounts the enrolled home separately from Lima and adopts an existing manual mount', async t => {
  const fixture = await createTempFixture(t);
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home'), HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  const selected = { ...profile(fixture.path('lima')), version: 2, mode: 'ssh-dev-target',
    sshPrimary: { targetName: 'nl2', stackName: 'lane' },
    workspaces: [{ id: '0.3', guestDir: '/home/guest/workspace/0.3' }] };
  await mkdir(fixture.path('stacks', 'lane'), { recursive: true });
  await writeFile(fixture.path('stacks', 'lane', 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'nl2', platform: 'posix', ssh: 'enrolled-nl2', sshConfigFile: fixture.path('ssh-config'),
      repoDir: '/home/guest/workspace/0.3', cliHomeDir: '/home/guest/.happier/cli' }] }));
  const mountDir = fixture.path('home', 'nl2-home');
  let mounted = false;
  const launches = [];
  const boundary = {
    async capture(command) {
      if (command === 'mount') return { exitCode: 0, out: mounted ? `enrolled-nl2:/home/guest on ${mountDir} (macfuse)` : '' };
      if (command === 'ls' || command === 'sshfs') return { exitCode: 0, out: '' };
      throw new Error(`must preserve manual mount: ${command}`);
    },
    async start(command, args) { launches.push({ command, args }); mounted = true; return { exitCode: null }; },
  };
  const executor = { async capture(command, args) {
    assert.equal(command, 'ssh');
    assert.ok(args.includes('enrolled-nl2'));
    assert.ok(args.includes(fixture.path('ssh-config')));
    return { exitCode: 0, out: '/home/guest' };
  } };
  const options = { profile: selected, env, boundary, executor, platform: 'darwin', fileExists: () => true };
  const first = await mountExecutionHostWorkspace(options);
  assert.equal(first.mountDir, mountDir);
  assert.equal(first.remote, 'enrolled-nl2:/home/guest');
  assert.ok(launches[0].args.some(arg => arg.includes('volname=Happier nl2')));
  assert.ok(launches[0].args.includes(fixture.path('ssh-config')));
  await mountExecutionHostWorkspace(options);
  assert.equal(launches.length, 1);
  boundary.capture = async command => command === 'mount'
    ? { exitCode: 0, out: `enrolled-nl2:/home/guest on ${mountDir} (macfuse)` }
    : command === 'ls' ? { exitCode: 1, err: 'Device not configured' }
      : assert.fail(`must never replace the manual mount: ${command}`);
  await assert.rejects(mountExecutionHostWorkspace(options), /leaving.*mount.*in place/i);
  assert.equal(launches.length, 1);
  boundary.capture = async command => command === 'mount'
    ? { exitCode: 0, out: `lima-other:/home/guest on ${mountDir} (macfuse)` }
    : { exitCode: 0, out: '' };
  await assert.rejects(mountExecutionHostWorkspace(options), /different.*source/i);
});

test('workspace mount resolves the complete current guest home, refreshes SSH config, and is idempotent', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-' });
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  const sshConfig = fixture.path('lima', 'happier-agent-primary', 'ssh.config');
  await mkdir(fixture.path('lima', 'happier-agent-primary'), { recursive: true });
  await writeFile(sshConfig, 'Host lima-happier-agent-primary\n  HostName 127.0.0.1\n', 'utf8');

  let mounted = false;
  const calls = [];
  const seenSshConfigs = [];
  const boundary = {
    start: async (command, args) => {
      calls.push({ command, args });
      assert.equal(command, 'sshfs');
      seenSshConfigs.push(await readFile(args[args.indexOf('-F') + 1], 'utf8'));
      mounted = true;
      return { pid: 731, exitCode: null };
    },
    capture: async (command, args) => {
      calls.push({ command, args });
      if (command === 'mount') {
        return { exitCode: 0, out: mounted ? `macfuse on ${mountDir} (osxfuse)\n` : '', err: '' };
      }
      if (command === 'ls') return { exitCode: 0, out: '', err: '' };
      if (command === 'sshfs' && args[0] === '--version') return { exitCode: 0, out: 'SSHFS version 3\n', err: '' };
      if (command === 'sshfs') throw new Error('mounting SSHFS must not wait on its long-lived process');
      if (command === 'umount') {
        mounted = false;
        return { exitCode: 0, out: '', err: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
  const executor = {
    capture: async (command, args) => {
      assert.equal(command, 'limactl');
      assert.deepEqual(args, ['shell', 'happier-agent-primary', '--', 'sh', '-lc', 'printf %s "$HOME"']);
      return { exitCode: 0, out: '/home/leeroy.guest', err: '' };
    },
  };

  const first = await mountExecutionHostWorkspace({
    profile: profile(limaHome),
    mountDir,
    boundary,
    executor,
    platform: 'darwin',
    fileExists: () => true,
  });
  assert.equal(first.remote, 'lima-happier-agent-primary:/home/leeroy.guest');
  assert.equal(first.mounted, true);
  assert.match(seenSshConfigs[0], /HostName 127\.0\.0\.1/);
  const firstMount = calls.find((call) => call.command === 'sshfs' && call.args[0] !== '--version');
  assert.ok(firstMount.args.includes('ControlMaster=no'));
  assert.ok(firstMount.args.includes('ControlPath=none'));

  await unmountExecutionHostWorkspace({ profile: profile(limaHome), mountDir, boundary });
  await writeFile(sshConfig, 'Host lima-happier-agent-primary\n  HostName 127.0.0.2\n', 'utf8');
  const second = await mountExecutionHostWorkspace({
    profile: profile(limaHome),
    mountDir,
    boundary,
    executor,
    platform: 'darwin',
    fileExists: () => true,
  });
  assert.equal(second.mounted, true);
  assert.match(seenSshConfigs[1], /HostName 127\.0\.0\.2/);

  const idempotent = await mountExecutionHostWorkspace({
    profile: profile(limaHome),
    mountDir,
    boundary,
    executor,
    platform: 'darwin',
    fileExists: () => true,
  });
  assert.equal(idempotent.mounted, true);
  assert.equal(calls.filter((call) => call.command === 'sshfs' && call.args[0] !== '--version').length, 2);
});

test('workspace mount probes a listed SSHFS mount and remounts an inaccessible guest home after macOS unmount fallback', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-stale-' });
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  await mkdir(fixture.path('lima', 'happier-agent-primary'), { recursive: true });
  await writeFile(fixture.path('lima', 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  await mkdir(mountDir, { recursive: true });

  let mounted = true;
  let guestHomeReachable = false;
  const calls = [];
  const boundary = {
    start: async (command, args) => {
      calls.push({ command, args });
      assert.equal(command, 'sshfs');
      mounted = true;
      guestHomeReachable = true;
      return { pid: 732, exitCode: null };
    },
    capture: async (command, args) => {
      calls.push({ command, args });
      if (command === 'mount') {
        return { exitCode: 0, out: mounted ? `macfuse on ${mountDir} (osxfuse)\n` : '', err: '' };
      }
      if (command === 'ls') {
        return guestHomeReachable
          ? { exitCode: 0, out: '.happier-stack\n', err: '' }
          : { exitCode: 1, out: '', err: `ls: ${mountDir}: Device not configured` };
      }
      if (command === 'sshfs' && args[0] === '--version') return { exitCode: 0, out: 'SSHFS version 3\n', err: '' };
      if (command === 'umount') {
        return { exitCode: 1, out: '', err: `umount(${mountDir}): Resource busy -- try 'diskutil unmount'` };
      }
      if (command === 'diskutil') {
        if (args[1] !== 'force') {
          assert.deepEqual(args, ['unmount', mountDir]);
          return { exitCode: 1, out: '', err: `Unmount failed for ${mountDir}` };
        }
        assert.deepEqual(args, ['unmount', 'force', mountDir]);
        mounted = false;
        return { exitCode: 0, out: '', err: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
  const executor = {
    capture: async () => ({ exitCode: 0, out: '/home/leeroy.guest', err: '' }),
  };

  const stale = await inspectExecutionHostWorkspaceMount({
    profile: profile(limaHome),
    mountDir,
    boundary,
    platform: 'darwin',
    fileExists: () => true,
  });
  assert.equal(stale.mounted, true);
  assert.deepEqual(stale.health, {
    ok: false,
    code: 'mount_unreachable',
    message: `SSHFS mount is listed but its guest home is inaccessible: ls: ${mountDir}: Device not configured`,
  });

  const recovered = await mountExecutionHostWorkspace({
    profile: profile(limaHome),
    mountDir,
    boundary,
    executor,
    platform: 'darwin',
    fileExists: () => true,
  });
  assert.deepEqual(recovered.health, { ok: true, code: 'mounted' });
  assert.equal(calls.filter((call) => call.command === 'umount').length, 1);
  assert.equal(calls.filter((call) => call.command === 'diskutil').length, 2);
  assert.equal(calls.filter((call) => call.command === 'sshfs' && call.args[0] !== '--version').length, 1);
});

test('concurrent automatic mount reconciliations start only one SSHFS process', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-concurrent-' });
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  await mkdir(fixture.path('lima', 'happier-agent-primary'), { recursive: true });
  await writeFile(fixture.path('lima', 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  let mounted = false;
  let starts = 0;
  const boundary = {
    capture: async (command) => {
      if (command === 'mount') return { exitCode: 0, out: mounted ? `macfuse on ${mountDir} (osxfuse)\n` : '', err: '' };
      if (command === 'ls' || command === 'sshfs') return { exitCode: 0, out: '', err: '' };
      throw new Error(`unexpected command: ${command}`);
    },
    start: async () => {
      starts += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      mounted = true;
      return { pid: 733, exitCode: null };
    },
  };
  const input = {
    profile: profile(limaHome), mountDir, boundary, platform: 'darwin',
    fileExists: () => true,
    executor: { capture: async () => ({ exitCode: 0, out: '/home/leeroy.guest', err: '' }) },
  };
  const results = await Promise.all([mountExecutionHostWorkspace(input), mountExecutionHostWorkspace(input)]);
  assert.equal(starts, 1);
  assert.ok(results.every((result) => result.health.ok));
});

test('workspace mount waits for a valid slow SSHFS launch instead of imposing a local retry cutoff', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-slow-launch-' });
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  await mkdir(fixture.path('lima', 'happier-agent-primary'), { recursive: true });
  await writeFile(fixture.path('lima', 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  let started = false;
  let launchPolls = 0;
  const result = await mountExecutionHostWorkspace({
    profile: profile(limaHome),
    mountDir,
    platform: 'darwin',
    fileExists: () => true,
    executor: { capture: async () => ({ exitCode: 0, out: '/home/leeroy.guest', err: '' }) },
    boundary: {
      capture: async (command, args) => {
        if (command === 'mount') {
          if (started) launchPolls += 1;
          return {
            exitCode: 0,
            out: started && launchPolls > 100 ? `macfuse on ${mountDir} (osxfuse)\n` : '',
            err: '',
          };
        }
        if (command === 'ls' || (command === 'sshfs' && args[0] === '--version')) {
          return { exitCode: 0, out: '', err: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      start: async () => {
        started = true;
        return { pid: 735, exitCode: null };
      },
      delay: async () => {},
    },
  });

  assert.equal(result.mounted, true);
  assert.equal(launchPolls, 101);
});

test('workspace mount cancellation terminates the launched SSHFS child', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-cancel-' });
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  await mkdir(fixture.path('lima', 'happier-agent-primary'), { recursive: true });
  await writeFile(fixture.path('lima', 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  const controller = new AbortController();
  const signals = [];

  await assert.rejects(mountExecutionHostWorkspace({
    profile: profile(limaHome),
    mountDir,
    signal: controller.signal,
    platform: 'darwin',
    fileExists: () => true,
    executor: { capture: async () => ({ exitCode: 0, out: '/home/leeroy.guest', err: '' }) },
    boundary: {
      capture: async (command, args) => {
        if (command === 'mount') return { exitCode: 0, out: '', err: '' };
        if (command === 'ls' || (command === 'sshfs' && args[0] === '--version')) {
          return { exitCode: 0, out: '', err: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      start: async () => ({
        pid: 736,
        exitCode: null,
        kill: (signal) => {
          signals.push(signal);
          return true;
        },
      }),
      delay: async (_ms, options) => {
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        assert.equal(options.signal, controller.signal);
        throw error;
      },
    },
  }), { name: 'AbortError' });

  assert.deepEqual(signals, ['SIGTERM']);
});

test('workspace unmount removes every stacked layer and reports the unmounted state', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-unmount-layers-' });
  const mountDir = fixture.path('vm-home');
  let layers = 3;
  let unmounts = 0;
  const result = await unmountExecutionHostWorkspace({
    profile: profile(fixture.path('lima')),
    mountDir,
    platform: 'darwin',
    boundary: {
      capture: async (command) => {
        if (command === 'mount') {
          return {
            exitCode: 0,
            out: Array.from({ length: layers }, () => `macfuse on ${mountDir} (osxfuse)`).join('\n'),
            err: '',
          };
        }
        if (command === 'ls') return { exitCode: 0, out: '', err: '' };
        if (command === 'umount') {
          unmounts += 1;
          layers -= 1;
          return { exitCode: 0, out: '', err: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    },
  });

  assert.equal(unmounts, 3);
  assert.equal(result.mounted, false);
  assert.deepEqual(result.health, { ok: true, code: 'ready' });
});

test('active Stack mount supervision repairs a crashed SSHFS mount and stops on cancellation', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-supervise-' });
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  await mkdir(fixture.path('lima', 'happier-agent-primary'), { recursive: true });
  await writeFile(fixture.path('lima', 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  const controller = new AbortController();
  let mounted = true;
  let reachable = true;
  let starts = 0;
  let delays = 0;
  const boundary = {
    capture: async (command) => {
      if (command === 'mount') return { exitCode: 0, out: mounted ? `macfuse on ${mountDir} (osxfuse)\n` : '', err: '' };
      if (command === 'ls') return { exitCode: reachable ? 0 : 1, out: '', err: reachable ? '' : 'Device not configured' };
      if (command === 'umount') { mounted = false; return { exitCode: 0, out: '', err: '' }; }
      if (command === 'sshfs') return { exitCode: 0, out: '', err: '' };
      throw new Error(`unexpected command: ${command}`);
    },
    start: async () => { starts += 1; mounted = true; reachable = true; return { pid: 734, exitCode: null }; },
    delay: async () => {
      delays += 1;
      if (delays === 1) reachable = false;
      if (delays === 2) controller.abort();
    },
  };
  const result = await superviseExecutionHostWorkspaceMount({
    profile: profile(limaHome), mountDir, boundary, signal: controller.signal,
    platform: 'darwin', fileExists: () => true,
    executor: { capture: async () => ({ exitCode: 0, out: '/home/leeroy.guest', err: '' }) },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(starts, 1);
  assert.equal(reachable, true);
});

test('active Stack mount supervision does not force-unmount a transiently slow live mount', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-workspace-mount-slow-' });
  const mountDir = fixture.path('vm-home');
  const controller = new AbortController();
  let unmounts = 0;
  const result = await superviseExecutionHostWorkspaceMount({
    profile: profile(fixture.path('lima')),
    mountDir,
    signal: controller.signal,
    platform: 'darwin',
    boundary: {
      capture: async (command) => {
        if (command === 'mount') return { exitCode: 0, out: `macfuse on ${mountDir} (osxfuse)\n`, err: '' };
        if (command === 'ls') return { exitCode: 1, out: '', err: '', timedOut: true };
        if (command === 'umount') { unmounts += 1; return { exitCode: 0, out: '', err: '' }; }
        throw new Error(`unexpected command: ${command}`);
      },
      delay: async () => controller.abort(),
    },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(unmounts, 0);
});

test('workspace mount status identifies a macFUSE approval blocker without attempting another mount mechanism', async () => {
  const inspected = await inspectExecutionHostWorkspaceMount({
    profile: profile('/Users/leeroy/.happier-stack/lima'),
    mountDir: '/Users/leeroy/.happier-stack/vm-home',
    platform: 'darwin',
    fileExists: () => false,
    boundary: {
      capture: async (command) => {
        assert.equal(command, 'mount');
        return { exitCode: 0, out: '', err: '' };
      },
    },
  });

  assert.equal(inspected.mounted, false);
  assert.deepEqual(inspected.health, {
    ok: false,
    code: 'macfuse_not_approved',
    message: 'macFUSE is installed but its filesystem extension is unavailable; finish the vendor installer and approve it in System Settings',
  });
});
