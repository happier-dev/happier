import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiKv server generation guard', () => {
    it('rejects stale kvGet responses after active server generation changes', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'tab' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).pathname !== '/v1/kv/k') return Response.json({});
            await upsertAndActivateServer({ serverUrl: 'https://other.example.test', scope: 'tab' });
            return {
                ok: true,
                status: 200,
                json: async () => ({ key: 'k', value: 'v', version: 1 }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { kvGet } = await import('./apiKv');
        await expect(kvGet(credentials, 'k')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });
});
