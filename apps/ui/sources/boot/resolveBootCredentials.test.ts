import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCredentialsMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: (...args: unknown[]) => getCredentialsMock(...args),
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
    },
}));

function createStorageMock() {
    const store = new Map<string, string>();
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
    };
}

function stubWebRuntime(href: string): void {
    const localStorage = createStorageMock();
    const sessionStorage = createStorageMock();
    vi.stubGlobal('window', {
        location: { href },
        localStorage,
        history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('document', {});
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
}

describe('resolveBootCredentials', () => {
    beforeEach(() => {
        getCredentialsMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('prefers server-scoped credentials and bootstraps the active server when the web location overrides the server', async () => {
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2Flocalhost%3A24731');

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://other.example.test');

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stack-token', secret: 'stack-secret' });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: 'stack-secret' });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://localhost:24731');
        expect(getCredentialsMock).not.toHaveBeenCalled();
        expect(getServerUrl()).toBe('http://localhost:24731');
    });

    it('falls back to default credentials when no web server override exists', async () => {
        stubWebRuntime('http://happier.example.test/');
        getCredentialsMock.mockResolvedValue({ token: 'default-token', secret: 'default-secret' });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'default-token', secret: 'default-secret' });
        expect(getCredentialsMock).toHaveBeenCalledTimes(1);
    });

});
