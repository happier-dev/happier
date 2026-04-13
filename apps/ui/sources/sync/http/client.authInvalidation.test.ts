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

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/machines');

        expect(resp.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith('http://localhost:3012', 'token-invalid', {
            serverId: 'server-a',
        });
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

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const resp = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(resp.status).toBe(401);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledTimes(1);
        expect(invalidateCredentialsTokenForServerUrl).toHaveBeenCalledWith('http://localhost:3012', 'token-invalid', {
            serverId: 'server-a',
        });
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

        let profileCalls = 0;
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/account/profile')) {
                const response = profileCalls === 0
                    ? { ok: false, status: 401, headers: new Headers() }
                    : { ok: true, status: 200, headers: new Headers() };
                profileCalls += 1;
                return response;
            }
            return { ok: true, status: 200, headers: new Headers() };
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
        expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/account/profile'))).toHaveLength(2);
    });

    it('emits an auth-credential invalidation notification when a bearer token is rejected', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const notifyAuthCredentialsInvalidated = vi.fn();
        vi.doMock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
            notifyAuthCredentialsInvalidated,
        }));

        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => true),
            },
        }));

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const response = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(response.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated).toHaveBeenCalledTimes(1);
        expect(notifyAuthCredentialsInvalidated).toHaveBeenCalledWith({
            serverId: 'server-a',
            serverUrl: 'http://localhost:3012',
            token: 'token-invalid',
        });
    });

    it('does not emit an auth-credential invalidation notification when the stored credentials were not invalidated', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:3012',
                kind: 'custom',
                generation: 1,
            }),
        }));

        const notifyAuthCredentialsInvalidated = vi.fn();
        vi.doMock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
            notifyAuthCredentialsInvalidated,
        }));

        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));

        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200, headers: new Headers() };
            }
            return { ok: false, status: 401, headers: new Headers() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        const response = await serverFetch('/v1/machines', {
            headers: {
                Authorization: 'Bearer token-invalid',
            },
        }, { includeAuth: false });

        expect(response.status).toBe(401);
        expect(notifyAuthCredentialsInvalidated).not.toHaveBeenCalled();
    });
});
