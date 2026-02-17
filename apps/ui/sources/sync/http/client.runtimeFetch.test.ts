import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('serverFetch runtime fetch override', () => {
    it('uses the configured runtime fetch implementation instead of global fetch', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));

        const globalFetchMock = vi.fn(async () => {
            throw new Error('global fetch should not be called');
        });
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);

        const client = await import('./client');
        expect((client as unknown as { setRuntimeFetch?: unknown }).setRuntimeFetch).toBeTypeOf('function');

        const overrideFetch = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));
        (client as unknown as {
            setRuntimeFetch: (next: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => void;
        }).setRuntimeFetch(overrideFetch);

        const resp = await (client as unknown as { serverFetch: typeof import('./client').serverFetch }).serverFetch(
            '/v1/health',
        );
        expect(resp.status).toBe(200);
        expect(overrideFetch).toHaveBeenCalledTimes(1);
        expect(globalFetchMock).not.toHaveBeenCalled();
    });
});
