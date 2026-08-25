import { describe, expect, it, vi } from 'vitest';

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

import { readBackgroundServiceHealth } from './readBackgroundServiceHealth';

describe('readBackgroundServiceHealth', () => {
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
    expect(spawnSyncMock.mock.calls.map(([command]) => command)).toEqual(['systemctl', 'journalctl']);
  });
});
