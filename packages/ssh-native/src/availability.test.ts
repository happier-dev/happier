import { describe, expect, it } from 'vitest';

import {
  createUnavailableNativeSshAvailability,
  getNativeSshAvailability,
  normalizeNativeSshAvailability,
} from './availability';

import type { NativeSshAvailability, NativeSshModule } from './HappierSshNative.types';

describe('native SSH availability', () => {
  it('returns unsupported-platform when the runtime platform cannot host the native module', () => {
    expect(getNativeSshAvailability({ nativeModule: null, platform: 'web' })).toEqual({
      available: false,
      reason: 'unsupported-platform',
      detail: 'Native SSH transport is only available on iOS and Android native builds.',
    });
  });

  it('returns native-module-missing when iOS or Android has no linked module', () => {
    expect(getNativeSshAvailability({ nativeModule: null, platform: 'ios' })).toEqual({
      available: false,
      reason: 'native-module-missing',
      detail: 'HappierSshNative is not linked in this native build.',
    });
  });

  it('normalizes malformed native availability as engine-unavailable', () => {
    expect(normalizeNativeSshAvailability({ available: true, platform: 'web', engine: 'russh', moduleVersion: '' })).toEqual({
      available: false,
      reason: 'engine-unavailable',
      detail: 'HappierSshNative returned an invalid availability payload.',
    });
  });

  it('returns native module availability when the linked module reports a valid engine', () => {
    const availability: NativeSshAvailability = {
      available: true,
      platform: 'android',
      engine: 'russh',
      moduleVersion: '0.0.0',
    };
    const nativeModule: NativeSshModule = {
      getAvailability: () => availability,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };

    expect(getNativeSshAvailability({ nativeModule, platform: 'android' })).toBe(availability);
  });

  it('creates structured unavailable results with optional details', () => {
    expect(createUnavailableNativeSshAvailability('build-not-included', 'HAPPIER_ENABLE_NATIVE_SSH=0')).toEqual({
      available: false,
      reason: 'build-not-included',
      detail: 'HAPPIER_ENABLE_NATIVE_SSH=0',
    });
  });
});
