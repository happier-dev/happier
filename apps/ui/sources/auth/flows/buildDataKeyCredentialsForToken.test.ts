import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

const getRandomBytesAsyncMock = vi.fn(async (len: number) => new Uint8Array(len).fill(7));
vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytesAsync: (len: number) => getRandomBytesAsyncMock(len),
}));

describe('buildDataKeyCredentialsForToken', () => {
    let restoreLocalStorage: (() => void) | null = null;

    beforeEach(() => {
        vi.resetModules();
        getRandomBytesAsyncMock.mockClear();
    });

    afterEach(async () => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        vi.restoreAllMocks();
        try {
            const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
            setServerUrl(null);
        } catch {
            // ignore
        }
    });

    it('creates new dataKey credentials when no stored dataKey credentials exist', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://server.example.test');

        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');
        const creds = await buildDataKeyCredentialsForToken('token-1');

        expect(creds).toHaveProperty('token', 'token-1');
        expect((creds as any).encryption?.publicKey).toEqual(expect.any(String));
        expect((creds as any).encryption?.machineKey).toEqual(expect.any(String));
    });

    it('reuses stored dataKey encryption keys when present', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://server.example.test');

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(
            TokenStorage.setCredentials({
                token: 'old-token',
                encryption: { publicKey: 'pk', machineKey: 'mk' },
            } as any),
        ).resolves.toBe(true);

        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');
        const creds = await buildDataKeyCredentialsForToken('new-token');

        expect(creds).toEqual({ token: 'new-token', encryption: { publicKey: 'pk', machineKey: 'mk' } });
    });
});

