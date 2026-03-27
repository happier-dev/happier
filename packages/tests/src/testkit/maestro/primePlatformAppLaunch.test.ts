import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultPrimePlatformAppLaunch, parseResolvedAndroidLaunchableActivity } from './primePlatformAppLaunch';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

describe('primePlatformAppLaunch', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('parses the launchable Android activity from resolve-activity output', () => {
    expect(
      parseResolvedAndroidLaunchableActivity(
        'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n' +
          'dev.happier.app.dev/.MainActivity\n',
        'dev.happier.app.dev',
      ),
    ).toBe('dev.happier.app.dev/.MainActivity');
  });

  it('prelaunches the resolved Android launcher activity', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n' +
          'dev.happier.app.dev/.MainActivity\n',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Status: ok',
        stderr: '',
      });

    await defaultPrimePlatformAppLaunch({
      env: {
        ...process.env,
        ANDROID_SERIAL: 'emulator-5554',
      },
      platform: 'android',
      appId: 'dev.happier.app.dev',
    });

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      'adb',
      ['-s', 'emulator-5554', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', 'dev.happier.app.dev'],
      expect.objectContaining({
        encoding: 'utf8',
        env: expect.objectContaining({
          ANDROID_SERIAL: 'emulator-5554',
        }),
      }),
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      'adb',
      ['-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-n', 'dev.happier.app.dev/.MainActivity'],
      expect.objectContaining({
        encoding: 'utf8',
      }),
    );
  });

  it('throws when the Android launcher activity cannot be resolved', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n',
      stderr: '',
    });

    await expect(
      defaultPrimePlatformAppLaunch({
        env: process.env,
        platform: 'android',
        appId: 'dev.happier.app.dev',
      }),
    ).rejects.toThrow(/could not be resolved/i);
  });
});
