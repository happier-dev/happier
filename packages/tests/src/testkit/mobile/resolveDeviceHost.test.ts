import { describe, expect, it } from 'vitest';

import { resolveDeviceVisibleBaseUrl } from './resolveDeviceHost';

describe('resolveDeviceVisibleBaseUrl', () => {
  it('rewrites localhost to 10.0.2.2 for android emulator', () => {
    expect(
      resolveDeviceVisibleBaseUrl({
        platform: 'android',
        baseUrl: 'http://127.0.0.1:24580',
        env: {},
      }),
    ).toBe('http://10.0.2.2:24580');
  });

  it('keeps loopback for ios by default', () => {
    expect(
      resolveDeviceVisibleBaseUrl({
        platform: 'ios',
        baseUrl: 'http://127.0.0.1:24580',
        env: {},
      }),
    ).toBe('http://127.0.0.1:24580');
  });

  it('supports explicit device host override', () => {
    expect(
      resolveDeviceVisibleBaseUrl({
        platform: 'android',
        baseUrl: 'http://127.0.0.1:24580',
        env: { HAPPIER_E2E_MOBILE_DEVICE_HOST: '192.168.0.10' } as any,
      }),
    ).toBe('http://192.168.0.10:24580');
  });
});
