import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const spawnMock = vi.fn((..._args: any[]) => ({ unref() {} }));
const execFileMock = vi.fn((...args: any[]) => {
  const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
  callback(null, '', '');
});
const resolveDaemonLaunchSpecMock = vi.fn(async (..._args: any[]) => ({
  filePath: '/usr/bin/node',
  args: ['--no-warnings', '--no-deprecation', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
}));

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
  execFile: (...args: any[]) => execFileMock(...args),
}));

vi.mock('./resolveDaemonLaunchSpec', () => ({
  resolveDaemonLaunchSpec: (...args: any[]) => resolveDaemonLaunchSpecMock(...args),
}));

describe('spawnDetachedDaemonStartSync', () => {
  it('adds successor-specific bounded authorization for self-restart launches', async () => {
    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({ startupSource: 'self-restart', env: {} });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['daemon', 'start-sync']),
      expect.objectContaining({
        env: expect.objectContaining({
          HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID: expect.stringMatching(/^self-restart-/),
          HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS: expect.any(String),
        }),
      }),
    );
  });
  const envScope = createEnvKeyScope([
    'HAPPIER_RELEASE_RING',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_STARTUP_SOURCE',
    'HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT',
    'DBUS_SESSION_BUS_ADDRESS',
  ]);
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    envScope.restore();
    spawnMock.mockClear();
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: any[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, '', '');
    });
    resolveDaemonLaunchSpecMock.mockClear();
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
      DBUS_SESSION_BUS_ADDRESS: undefined,
    });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0] as any[];
    expect(options?.env?.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('dev');
  });

  it('launches a detached Linux daemon in the provisioned critical systemd slice', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    const userBus = 'unix:path=/run/user/501/bus';
    execFileMock.mockImplementationOnce((...args: any[]) => {
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, 'LoadState=loaded\nMemoryLow=4294967296\n', '');
    });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({
      env: { DBUS_SESSION_BUS_ADDRESS: userBus },
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'systemd-run',
      [
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
      ],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({ DBUS_SESSION_BUS_ADDRESS: userBus }),
      }),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'systemctl',
      [
        '--user',
        'show',
        'happier-critical.slice',
        '--property=LoadState',
        '--property=MemoryLow',
      ],
      expect.objectContaining({
        timeout: 1_000,
        maxBuffer: 16 * 1024,
        env: expect.objectContaining({ DBUS_SESSION_BUS_ADDRESS: userBus }),
      }),
      expect.any(Function),
    );
  });

  it('keeps the direct launch when Linux has no user-systemd bus', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({ env: {} });

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['--no-warnings', '--no-deprecation', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }),
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('lets an explicit startup source override an inherited daemon startup source', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    envScope.patch({
      HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      HAPPIER_HOME_DIR: '/tmp/happier-cli-test-home',
      DBUS_SESSION_BUS_ADDRESS: undefined,
    });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({
      startupSource: 'self-restart',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0] as any[];
    expect(options?.env?.HAPPIER_DAEMON_STARTUP_SOURCE).toBe('self-restart');
  });

  it('resolves the successor launch from the detached child environment', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '1111111111111111',
    });
    const successorEnv = {
      ...process.env,
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '2222222222222222',
      DBUS_SESSION_BUS_ADDRESS: undefined,
    };

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync({
      startupSource: 'self-restart',
      env: successorEnv,
    });

    expect(resolveDaemonLaunchSpecMock).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      successorEnv,
    );
  });

  it('uses Start-Process on Windows so detached daemon launch handles cmd/runtime paths reliably', async () => {
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
