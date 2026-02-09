import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('serverFetch abort handling', () => {
    it('aborts in-flight requests when abortServerFetches is called', async () => {
        vi.doMock('../serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));
        vi.doMock('@/auth/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
            },
        }));

        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            return await new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) {
                    reject(new Error('missing signal'));
                    return;
                }
                if (signal.aborted) {
                    const error = new Error('aborted');
                    (error as any).name = 'AbortError';
                    reject(error);
                    return;
                }
                signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    (error as any).name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { abortServerFetches, serverFetch } = await import('./client');
        const pending = serverFetch('/v1/health');
        abortServerFetches();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects authenticated absolute-URL requests that target a different host than the active server', async () => {
        vi.doMock('../serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));
        vi.doMock('@/auth/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
            },
        }));

        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { serverFetch } = await import('./client');
        await expect(serverFetch('https://other.example.test/v1/account/profile')).rejects.toThrow(
            /active server/i,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
