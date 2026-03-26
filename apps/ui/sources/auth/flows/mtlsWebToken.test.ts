import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://api.example.test', generation: 1 }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: (...args: unknown[]) => getCredentialsMock(...args),
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
        invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
    },
}));

afterEach(async () => {
    try {
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
    } catch {
        // ignore
    }
    runtimeFetchMock.mockReset();
    getCredentialsMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('requestMtlsWebToken', () => {
    it('uses runtimeFetch via serverFetch (not global fetch)', async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error('Unexpected global fetch call');
        });
        vi.stubGlobal('fetch', fetchMock as any);

        getCredentialsMock.mockResolvedValue({ token: 'stale-token', secret: 'secret' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stale-token', secret: 'secret' });

        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
            if (url.includes('/v1/version')) return okJson({ version: '1' });
            if (url.includes('/health')) return okJson({ ok: true });
            if (url.includes('/v1/auth/ping')) return new Response(JSON.stringify({ ok: false }), { status: 401 });
            if (url.endsWith('/v1/auth/mtls')) return okJson({ token: 'mtls-token' });
            return okJson({});
        });

        const { requestMtlsWebToken } = await import('./mtlsWebToken');

        await expect(requestMtlsWebToken('https://api.example.test')).resolves.toBe('mtls-token');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
