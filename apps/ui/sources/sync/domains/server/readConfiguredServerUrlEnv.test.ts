import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

it('rewrites a stack LAN relay for every browser loopback address', async () => {
    vi.stubGlobal('window', { location: { hostname: '127.0.0.2' } });
    vi.stubGlobal('document', {});
    vi.doMock('./serverContext', () => ({ isStackContext: () => true }));
    vi.doMock('@/sync/runtime/webRuntimeConfig', () => ({
        readWebRuntimeConfigServerUrl: () => 'http://192.168.1.20:3005',
    }));

    const { readConfiguredServerUrlEnv } = await import('./readConfiguredServerUrlEnv');

    expect(readConfiguredServerUrlEnv()).toBe('http://127.0.0.2:3005/');
});
