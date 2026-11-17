import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const spawnMock = vi.fn((..._args: any[]) => ({ unref() {} }));
const resolveDaemonLaunchSpecMock = vi.fn(async (..._args: any[]) => ({
  filePath: '/usr/bin/node',
  args: ['--no-warnings', '--no-deprecation', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
}));
const systemdScopeMocks = vi.hoisted(() => ({
  execFileWithDeadline: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

vi.mock('./resolveDaemonLaunchSpec', () => ({
  resolveDaemonLaunchSpec: (...args: any[]) => resolveDaemonLaunchSpecMock(...args),
}));

vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  execFileWithDeadline: systemdScopeMocks.execFileWithDeadline,
}));

describe('spawnDetachedDaemonStartSync', () => {
  const envScope = createEnvKeyScope(['HAPPIER_RELEASE_RING', 'HAPPIER_PUBLIC_RELEASE_CHANNEL', 'HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_SERVICE_MANAGED_BY', 'HAPPIER_DAEMON_SERVICE_BUNDLE_ID', 'HAPPIER_DAEMON_SERVICE_AUTOSTART']);
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    envScope.restore();
    spawnMock.mockClear();
    resolveDaemonLaunchSpecMock.mockClear();
    systemdScopeMocks.execFileWithDeadline.mockReset();
    systemdScopeMocks.execFileWithDeadline.mockResolvedValue({ stdout: '', stderr: '' });
    vi.resetModules();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('resolves the launch spec from the requested successor environment', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    const successorEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abcdef1234567890',
    };

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({ env: successorEnv });

    expect(resolveDaemonLaunchSpecMock).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      successorEnv,
    );
  });

  it('launches a future Linux daemon in the provisioned critical user slice', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
    };
    systemdScopeMocks.execFileWithDeadline.mockResolvedValue({
      stdout: 'LoadState=loaded\nMemoryLow=4294967296\n',
      stderr: '',
    });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({ env: daemonEnv });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as any[];
    expect(command).toBe('systemd-run');
    expect(args).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--slice=happier-critical.slice',
      '--',
      '/usr/bin/node',
      '--no-warnings',
      '--no-deprecation',
      '/opt/happier/package-dist/index.mjs',
      'daemon',
      'start-sync',
    ]);
    expect(args.join(' ')).not.toMatch(/happier-jobs|--nice|MemoryMax|MemoryHigh|MemoryLimit/u);
    expect(options).toEqual(expect.objectContaining({
      detached: true,
      stdio: ['ignore', 'ignore', expect.any(Number)],
      env: expect.objectContaining({
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
      }),
    }));
    expect(systemdScopeMocks.execFileWithDeadline).toHaveBeenCalledWith(
      'systemctl',
      [
        '--user',
        'show',
        'happier-critical.slice',
        '--property=LoadState',
        '--property=MemoryLow',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        }),
      }),
    );
  });

  it('retains launcher failure diagnostics delivered after exit', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const launcherChild = Object.assign(new EventEmitter(), { stdout, stderr, unref() {} });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        launcherChild.emit('exit', 1);
        stderr.emit('data', 'Start-Process failed');
        launcherChild.emit('close', 1);
      });
      return launcherChild as any;
    });
    const mod = await import('./spawnDetachedDaemonStartSync');
    await expect(mod.spawnDetachedDaemonStartSync()).rejects.toThrow('Start-Process failed');
  });

  it.each(['before', 'after', 'split-after'] as const)('returns the Windows daemon PID delivered %s launcher exit while the daemon retains inherited pipes', async (pidDelivery) => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const stdout = Object.assign(new EventEmitter(), { destroy() {} });
    const stderr = Object.assign(new EventEmitter(), { destroy() {} });
    const launcherChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      unref() {},
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (pidDelivery === 'before') stdout.emit('data', '24680\r\n');
        launcherChild.emit('exit', 0);
        if (pidDelivery === 'after') stdout.emit('data', '24680\r\n');
        if (pidDelivery === 'split-after') {
          stdout.emit('data', '24');
          queueMicrotask(() => stdout.emit('data', '680\r\n'));
        }
      });
      return launcherChild as any;
    });
    resolveDaemonLaunchSpecMock.mockImplementationOnce(async () => ({
      filePath: 'C:\\hq\\windetachedfix-001\\happier-v0.2.4-windows-x64\\happier.exe',
      args: ['daemon', 'start-sync'],
    }));

    const mod = await import('./spawnDetachedDaemonStartSync');
    let child: Awaited<ReturnType<typeof mod.spawnDetachedDaemonStartSync>> | undefined;
    const launch = mod.spawnDetachedDaemonStartSync().then(result => { child = result; });
    try {
      await expect.poll(() => child).toBeDefined();
    } finally {
      // A descendant closes inherited handles only on exit. The launch itself
      // must already have returned, as observed on real Windows PowerShell.
      launcherChild.emit('close', 0);
      await launch;
    }

    expect(child).toBe(launcherChild);
    expect(child).toHaveProperty('detachedDaemonPid', 24680);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as any[];
    expect(command.toLowerCase()).toContain('powershell');
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']));
    const commandIndex = args.indexOf('-Command');
    const script = args[commandIndex + 1] ?? '';
    expect(script).toContain('Start-Process');
    expect(script).toContain('-FilePath');
    expect(script).toContain('-ArgumentList');
    expect(script).toContain('-WorkingDirectory');
    expect(script).toContain('-WindowStyle Hidden');
    expect(script).toContain('-PassThru');
    expect(script).toContain('-RedirectStandardError');
    expect(script).toContain('-stderr-daemon.log');
    expect(script).toContain("-RedirectStandardOutput 'NUL'");
    expect(options).toEqual(expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
  });
});
