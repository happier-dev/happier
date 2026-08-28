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
  const envScope = createEnvKeyScope(['HAPPIER_RELEASE_RING', 'HAPPIER_PUBLIC_RELEASE_CHANNEL', 'HAPPIER_HOME_DIR']);
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

  it('propagates the public release channel to the detached daemon so state files are scoped per lane', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    envScope.patch({
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
      HAPPIER_HOME_DIR: '/tmp/happier-cli-test-home',
    });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0] as any[];
    expect(options?.env?.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('dev');
    expect(options?.env?.HAPPIER_DAEMON_STARTUP_SOURCE).toBe('manual');
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
      stdio: 'ignore',
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

  it('uses Win32_Process.Create on Windows so the detached daemon survives parent CLI exit', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const launcherChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      unref() {},
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        stdout.emit('data', '24680\r\n');
        launcherChild.emit('close', 0);
      });
      return launcherChild as any;
    });
    resolveDaemonLaunchSpecMock.mockImplementationOnce(async () => ({
      filePath: 'C:\\hq\\windetachedfix-001\\happier-v0.2.4-windows-x64\\happier.exe',
      args: ['daemon', 'start-sync'],
    }));

    const mod = await import('./spawnDetachedDaemonStartSync');
    const child = await mod.spawnDetachedDaemonStartSync();

    expect(child).toBe(launcherChild);
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
    expect(options).toEqual(expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
  });
});
