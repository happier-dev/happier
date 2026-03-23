import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
}));

describe('createSyncSocketReadinessProbe', () => {
    afterEach(() => {
        runtimeFetchMock.mockReset();
        vi.resetModules();
    });

    it('returns ready when health and authenticated probes succeed', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const { createSyncSocketReadinessProbe } = await import('./createSyncSocketReadinessProbe');
        const probe = createSyncSocketReadinessProbe({
            endpoint: 'https://server.example.test/',
            token: 'token-1',
        });

        await expect(probe()).resolves.toEqual({ status: 'ready' });
        expect(runtimeFetchMock).toHaveBeenNthCalledWith(
            1,
            'https://server.example.test/health',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(runtimeFetchMock).toHaveBeenNthCalledWith(
            2,
            'https://server.example.test/v1/features',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
    });

    it('classifies 401 from the authenticated probe as auth_failed', async () => {
        runtimeFetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 }));

        const { createSyncSocketReadinessProbe } = await import('./createSyncSocketReadinessProbe');
        const probe = createSyncSocketReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({
            status: 'auth_failed',
            statusCode: 401,
        }));
    });

    it('classifies transport failures as server_unreachable', async () => {
        runtimeFetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

        const { createSyncSocketReadinessProbe } = await import('./createSyncSocketReadinessProbe');
        const probe = createSyncSocketReadinessProbe({
            endpoint: 'https://server.example.test',
            token: 'token-1',
        });

        await expect(probe()).resolves.toEqual(expect.objectContaining({
            status: 'server_unreachable',
            errorMessage: 'connect ECONNREFUSED',
        }));
    });
});
