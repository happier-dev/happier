import { describe, expect, it, vi } from 'vitest';

import {
  HAPPIER_SSH_NATIVE_MODULE_NAME,
  readOptionalHappierSshNativeModuleFromExpoCore,
} from './HappierSshNative';
import type { NativeSshModule } from './HappierSshNative.types';

describe('HappierSshNative optional module loading', () => {
  it('returns null when Expo native module lookup throws', () => {
    const expoCore = {
      requireOptionalNativeModule: vi.fn(() => {
        throw new Error('native module registry unavailable');
      }),
    };

    expect(readOptionalHappierSshNativeModuleFromExpoCore(expoCore)).toBeNull();
    expect(expoCore.requireOptionalNativeModule).toHaveBeenCalledWith(HAPPIER_SSH_NATIVE_MODULE_NAME);
  });

  it('defines a host-key prompt response method on the native module contract', () => {
    const nativeModule = {
      getAvailability: () => ({
        available: true,
        platform: 'android',
        engine: 'libssh2',
        moduleVersion: '0.0.0',
        supportsLoopbackTunnel: true,
        supportsPersistentHostKeyStorage: false,
      } as const),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      respondToHostKeyPrompt: async () => undefined,
      cancelRequest: async () => undefined,
    } satisfies NativeSshModule;

    expect(typeof nativeModule.respondToHostKeyPrompt).toBe('function');
  });

  it('defines request cancellation on the native module contract', () => {
    const nativeModule = {
      getAvailability: () => ({
        available: true,
        platform: 'ios',
        engine: 'libssh2',
        moduleVersion: '0.0.0',
        supportsLoopbackTunnel: false,
        supportsPersistentHostKeyStorage: false,
      } as const),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      cancelRequest: async () => undefined,
    } satisfies NativeSshModule;

    expect(typeof nativeModule.cancelRequest).toBe('function');
  });
});
