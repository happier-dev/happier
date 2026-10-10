import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

beforeEach(async () => {
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    await upsertAndActivateServer({ serverUrl: 'http://localhost:53288', name: 'Debug Home' });
});

afterEach(async () => {
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('serverFetch debug logging', () => {
    it('logs request URL context when EXPO_PUBLIC_DEBUG=1 and runtime fetch fails', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const client = await import('./client');
        setRuntimeFetch(async (request) => {
            throw new TypeError(`Network request failed for ${String(request)}`);
        });

        await expect(client.serverFetch(
            '/v1/health',
            undefined,
            { includeAuth: false, retry: 'none' },
        )).rejects.toThrow('Network request failed');

        expect(logSpy).toHaveBeenCalled();
        const combined = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        expect(combined).toContain('serverFetch');
        expect(combined).toContain('http://localhost:53288/v1/health');
    });

    it('templates public-share capabilities when debug request logging is enabled', async () => {
        const secret = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const client = await import('./client');
        setRuntimeFetch(async (request) => {
            throw new TypeError(`Network request failed for ${String(request)}`);
        });

        await expect(client.serverFetch(
            `/v1/public-share/${secret}/messages`,
            undefined,
            { includeAuth: false, retry: 'none' },
        )).rejects.toThrow('Network request failed');

        const combined = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(combined).not.toContain(secret);
        expect(combined).toContain('/v1/public-share/:token/messages');
    });
});
