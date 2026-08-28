import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  inspectExecutionHostWorkspaceMount,
  mountExecutionHostWorkspace,
  resolveExecutionHostWorkspaceMount,
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
