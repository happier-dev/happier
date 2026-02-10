import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('serverFetch auth invalidation', () => {
    it('invalidates stored credentials when the server returns 401 for an authenticated request', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => ({ token: 'token-invalid', secret: 'secret-a' })),
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 401,
            headers: new Headers(),
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/machines');

        expect(resp.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith('http://localhost:3012', 'token-invalid');
    });

    it('invalidates stored credentials when includeAuth=false but an Authorization header is present', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 401,
            headers: new Headers(),
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(resp.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith('http://localhost:3012', 'token-invalid');
    });

    it('retries idempotent requests once with refreshed credentials after invalidating a rejected token', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const invalidateCredentialsTokenForServerUrl = vi.fn(async () => true);
        const getCredentials = vi.fn(async () => ({ token: 'token-refreshed', secret: 'secret-a' }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials,
                invalidateCredentialsTokenForServerUrl,
            },
        }));

        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                headers: new Headers(),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers(),
            });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/account/profile', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(resp.status).toBe(200);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(getCredentials).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
