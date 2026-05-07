import { describe, expect, it, vi } from 'vitest';

import { cancelNativeSshRequest } from './cancel';
import type { NativeSshModule } from './HappierSshNative.types';

describe('native SSH cancellation', () => {
  it('cancels an in-flight native request by request id', async () => {
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
      cancelRequest: vi.fn(async () => undefined),
    } satisfies NativeSshModule;

    await cancelNativeSshRequest({ requestId: 'request-1', nativeModule });

    expect(nativeModule.cancelRequest).toHaveBeenCalledWith('request-1');
  });
});
