import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCredentialsMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const readWebServerUrlOverrideFromLocationMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: (...args: unknown[]) => getCredentialsMock(...args),
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
    },
}));

vi.mock('@/sync/domains/server/url/bootstrapActiveServerFromWebLocation', () => ({
    readWebServerUrlOverrideFromLocation: (...args: unknown[]) => readWebServerUrlOverrideFromLocationMock(...args),
}));

describe('resolveBootCredentials', () => {
    beforeEach(() => {
        getCredentialsMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        readWebServerUrlOverrideFromLocationMock.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('prefers server-scoped credentials when the web location overrides the server', async () => {
        readWebServerUrlOverrideFromLocationMock.mockReturnValue({
            serverUrl: 'http://localhost:24731',
            cleanedRelativeUrl: '/',
        });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stack-token', secret: 'stack-secret' });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: 'stack-secret' });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://localhost:24731');
        expect(getCredentialsMock).not.toHaveBeenCalled();
    });

    it('falls back to default credentials when no web server override exists', async () => {
        readWebServerUrlOverrideFromLocationMock.mockReturnValue(null);
        getCredentialsMock.mockResolvedValue({ token: 'default-token', secret: 'default-secret' });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'default-token', secret: 'default-secret' });
        expect(getCredentialsMock).toHaveBeenCalledTimes(1);
    });
});
