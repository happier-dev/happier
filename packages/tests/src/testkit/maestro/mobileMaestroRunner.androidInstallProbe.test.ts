import { describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

describe('mobileMaestroRunner Android install probe', () => {
  it('passes the configured install probe timeout to adb pm path', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: 'package:/data/app/dev.happier.app.internaldev/base.apk\n',
      stderr: '',
    });

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_LOGCAT_CAPTURE: '0',
          HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
          HAPPIER_E2E_MOBILE_APP_INSTALL_CHECK_TIMEOUT_MS: '12345',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
        },
      },
      {
        runMaestro: vi.fn(async () => ({ exitCode: 0 })),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
      },
    );

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'adb',
      ['shell', 'pm', 'path', 'dev.happier.app.internaldev'],
      expect.objectContaining({
        timeout: 12345,
      }),
    );
  });
});
