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
          'dev.happier.app.internaldev/.MainActivity\n',
        'dev.happier.app.internaldev',
      ),
    ).toBe('dev.happier.app.internaldev/.MainActivity');
  });

  it('prelaunches the resolved Android launcher activity', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n' +
          'dev.happier.app.internaldev/.MainActivity\n',
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
      appId: 'dev.happier.app.internaldev',
    });

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      'adb',
      ['-s', 'emulator-5554', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', 'dev.happier.app.internaldev'],
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
      ['-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-n', 'dev.happier.app.internaldev/.MainActivity'],
      expect.objectContaining({
        encoding: 'utf8',
      }),
    );
  });

  it('retries Android launcher activity resolution before failing the prelaunch', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: 'No activity found\n',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n' +
          'dev.happier.app.internaldev/.MainActivity\n',
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
        HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_ATTEMPTS: '2',
        HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_RETRY_DELAY_MS: '1',
      },
      platform: 'android',
      appId: 'dev.happier.app.internaldev',
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      'adb',
      ['shell', 'cmd', 'package', 'resolve-activity', '--brief', 'dev.happier.app.internaldev'],
      expect.objectContaining({
        encoding: 'utf8',
      }),
    );
  });

  it('retries Android app start after resolving the launcher activity', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: 'dev.happier.app.internaldev/.MainActivity\n',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: Activity not started, unable to resolve Intent',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Status: ok',
        stderr: '',
      });

    await defaultPrimePlatformAppLaunch({
      env: {
        ...process.env,
        HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_ATTEMPTS: '2',
        HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_RETRY_DELAY_MS: '1',
      },
      platform: 'android',
      appId: 'dev.happier.app.internaldev',
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      'adb',
      ['shell', 'am', 'start', '-W', '-n', 'dev.happier.app.internaldev/.MainActivity'],
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
        env: {
          ...process.env,
          HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH_ATTEMPTS: '1',
        },
        platform: 'android',
        appId: 'dev.happier.app.internaldev',
      }),
    ).rejects.toThrow(/could not be resolved/i);
  });
});
