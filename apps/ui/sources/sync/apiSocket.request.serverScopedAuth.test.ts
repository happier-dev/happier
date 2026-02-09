import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenStorageMock = vi.hoisted(() => ({
    getCredentials: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
}));
const serverRuntimeMock = vi.hoisted(() => ({
    generation: 1,
    getActiveServerSnapshot: vi.fn(() => ({
        serverId: 'stack',
        serverUrl: 'https://stack.example.test',
        kind: 'custom',
        generation: serverRuntimeMock.generation,
    })),
}));

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: tokenStorageMock,
}));
vi.mock('@/sync/serverRuntime', () => ({
    getActiveServerSnapshot: () => serverRuntimeMock.getActiveServerSnapshot(),
}));

describe('apiSocket.request server-scoped credentials', () => {
    beforeEach(() => {
        tokenStorageMock.getCredentials.mockReset();
        tokenStorageMock.getCredentialsForServerUrl.mockReset();
        serverRuntimeMock.generation = 1;
        serverRuntimeMock.getActiveServerSnapshot.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('prefers credentials scoped to the configured endpoint', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });
        tokenStorageMock.getCredentials.mockResolvedValue({ token: 'global-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await apiSocket.request('/v1/ping');

        expect(tokenStorageMock.getCredentialsForServerUrl).toHaveBeenCalledWith('https://stack.example.test');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://stack.example.test/v1/ping',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer scoped-token',
                }),
            }),
        );
    });

    it('rejects stale responses when active server generation changes mid-request', async () => {
        const fetchMock = vi.fn(async () => {
            serverRuntimeMock.generation = 2;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 's' });
        tokenStorageMock.getCredentials.mockResolvedValue({ token: 'global-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await expect(apiSocket.request('/v1/ping')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });

    it('does not fall back to active-server credentials when endpoint-scoped credentials are missing', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue(null);
        tokenStorageMock.getCredentials.mockResolvedValue({ token: 'global-token', secret: 's' });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).config = { endpoint: 'https://stack.example.test', token: 'unused' };

        await expect(apiSocket.request('/v1/ping')).rejects.toThrow('No authentication credentials');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
