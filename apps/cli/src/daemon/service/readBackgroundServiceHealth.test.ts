import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn<typeof import('node:child_process').spawnSync>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { readBackgroundServiceHealth, readBackgroundServiceAutostartMode, readBackgroundServiceActivity } from './readBackgroundServiceHealth';

describe('readBackgroundServiceHealth', () => {
  const envScope = createEnvKeyScope(['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  beforeEach(() => {
    spawnSyncMock.mockReset();
    envScope.patch({ XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: undefined });
  });
  afterEach(() => envScope.restore());
  it('distinguishes denied and timed-out launchd queries from loaded and proven unloaded services', () => {
    const params = { platform: 'darwin' as const, uid: 501, label: 'com.happier.cli.daemon.company' };
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'Operation not permitted' } as never);
    expect(readBackgroundServiceActivity(params)).toBe('unknown');
    spawnSyncMock.mockReturnValue({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }) } as never);
    expect(readBackgroundServiceActivity(params)).toBe('unknown');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'gui/501/com.happier.cli.daemon.company = {\n state = running\n}', stderr: '' } as never);
    expect(readBackgroundServiceActivity(params)).toBe('active');
    spawnSyncMock.mockReturnValue({ status: 113, stdout: '', stderr: 'Could not find service "com.happier.cli.daemon.company" in domain for user gui: 501' } as never);
    expect(readBackgroundServiceActivity(params)).toBe('inactive');
  });
  it('reads launchd overrides and real Windows triggers, returning unknown on failed queries', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'disabled services = {\n "com.happier.cli.daemon.company" => false\n}', stderr: '' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'darwin', uid: 501, label: 'com.happier.cli.daemon.company', installedMode: 'on-demand' })).toBe('on-demand');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'disabled services = {\n "com.happier.cli.daemon.company" => true\n}', stderr: '' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'darwin', uid: 501, label: 'com.happier.cli.daemon.company', installedMode: 'at-login' })).toBe('on-demand');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify({ exists: true, enabled: true, autostart: false }), stderr: '' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'win32', uid: null, label: 'Happier\\happier-daemon.company', installedMode: 'at-login' })).toBe('on-demand');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify({ exists: true, enabled: true, autostart: true }), stderr: '' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'win32', uid: null, label: 'Happier\\happier-daemon.company', installedMode: 'on-demand' })).toBe('at-login');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'unavailable' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'darwin', uid: 501, label: 'com.happier.cli.daemon.company', installedMode: 'at-login' })).toBeNull();
  });
  it('reads actual systemd login enablement rather than trusting the definition marker', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'UnitFileState=disabled\n', stderr: '' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'linux', uid: 501, label: 'happier-daemon.company', installedMode: 'at-login' })).toBe('on-demand');
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'UnitFileState=enabled\n', stderr: '' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'linux', uid: 501, label: 'happier-daemon.company', installedMode: 'on-demand' })).toBe('at-login');
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'no bus' } as never);
    expect(readBackgroundServiceAutostartMode({ platform: 'linux', uid: 501, label: 'happier-daemon.company', installedMode: 'at-login' })).toBeNull();
  });

  it('classifies a failed restarting systemd user service as crash-looping', () => {
    spawnSyncMock.mockImplementation((cmd, args) => {
      if (cmd === 'systemctl') {
        return {
          status: 0,
          stdout: [
            'Result=exit-code',
            'ExecMainStatus=1',
            'NRestarts=7',
            'ActiveState=failed',
            'SubState=failed',
            '',
          ].join('\n'),
          stderr: '',
        } as never;
      }
      if (cmd === 'journalctl') {
        return {
          status: 0,
          stdout: [
            'Apr 29 17:00:01 host happier-daemon.default[123]: starting',
            'Apr 29 17:00:02 host happier-daemon.default[123]: not authenticated',
            '',
          ].join('\n'),
          stderr: '',
        } as never;
      }
      return { status: 1, stdout: '', stderr: '' } as never;
    });

    const health = readBackgroundServiceHealth({
      platform: 'linux',
      uid: 98765,
      label: 'happier-daemon.default',
      errLogPath: null,
    });

    expect(health).toMatchObject({
      runs: 7,
      lastExitCode: 1,
      isCrashLooping: true,
      lastErrorLine: 'Apr 29 17:00:02 host happier-daemon.default[123]: not authenticated',
      suspectedCause: 'auth_missing',
      conflictingManualDaemonPid: null,
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      [
        '--user',
        'show',
        'happier-daemon.default.service',
        '--property=Result,ExecMainStatus,NRestarts,ActiveState,SubState',
        '--no-pager',
      ],
      expect.objectContaining({
        encoding: 'utf-8',
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: '/run/user/98765',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/98765/bus',
        }),
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'journalctl',
      ['--user', '-u', 'happier-daemon.default.service', '-n', '40', '--no-pager'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});
