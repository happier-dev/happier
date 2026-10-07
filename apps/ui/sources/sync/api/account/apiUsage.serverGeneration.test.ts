import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiUsage server generation guard', () => {
    it('rejects stale queryUsage responses after active server generation changes', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'tab' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).pathname !== '/v1/usage/query') return Response.json({});
            await upsertAndActivateServer({ serverUrl: 'https://other.example.test', scope: 'tab' });
            return {
                ok: true,
                status: 200,
                json: async () => ({ usage: [] }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { queryUsage } = await import('./apiUsage');
        await expect(queryUsage(credentials, {})).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });
});
