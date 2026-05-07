import { describe, expect, it, vi } from 'vitest';
import type { NativeSshModule } from './HappierSshNative.types';

describe('native SSH tunnel helpers', () => {
  it('starts and stops loopback tunnels through the optional native module', async () => {
    const loaded = await import('./tunnels').catch(() => null);
    expect(loaded).not.toBeNull();

    const nativeModule = {
      getAvailability: () => ({
        available: true,
        platform: 'ios',
        engine: 'russh',
        moduleVersion: '0.0.0',
        supportsLoopbackTunnel: true,
        supportsPersistentHostKeyStorage: false,
      } as const),
      exec: vi.fn(),
      cancelRequest: vi.fn(async () => undefined),
      startLoopbackTunnel: vi.fn(async () => ({
        nativeTunnelId: 'native-1',
        localPort: 49152,
      })),
      stopLoopbackTunnel: vi.fn(async () => undefined),
    } satisfies NativeSshModule;

    await expect(loaded!.startNativeSshLoopbackTunnel({
      nativeModule,
      request: {
        requestId: 'request-1',
        host: '10.0.0.5',
        port: 22,
        username: 'dev',
        auth: { username: 'dev', password: 'secret' },
        hostKeyVerification: { decision: 'accept-once', fingerprintSha256: 'SHA256:abc' },
        destinationHost: '127.0.0.1',
        destinationPort: 3005,
        requestedLocalPort: 49152,
        connectTimeoutMs: 1000,
        authTimeoutMs: 1000,
      },
    })).resolves.toEqual({
      nativeTunnelId: 'native-1',
      localPort: 49152,
    });
    await loaded!.stopNativeSshLoopbackTunnel({
      nativeModule,
      nativeTunnelId: 'native-1',
    });

    expect(nativeModule.startLoopbackTunnel).toHaveBeenCalledTimes(1);
    expect(nativeModule.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
  });
});
