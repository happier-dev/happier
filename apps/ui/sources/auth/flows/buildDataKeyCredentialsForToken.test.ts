import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('expo-secure-store', () => ({}));

const runtimeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

function tokenForAccount(accountId: string, signature = 'signature'): string {
    return `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.${signature}`;
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('buildDataKeyCredentialsForToken', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let plaintextMachineFeature: unknown;
    let featureStatus: number;

    beforeEach(async () => {
        vi.resetModules();
        restoreLocalStorage = installLocalStorageMock().restore;
        plaintextMachineFeature = { enabled: true };
        featureStatus = 200;
        runtimeFetchMock.mockReset();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/v1/features')) {
                const base = createRootLayoutFeaturesResponse();
                return jsonResponse({
                    ...base,
                    features: {
                        ...base.features,
                        encryption: { ...base.features.encryption, plaintextMachine: plaintextMachineFeature },
                    },
                }, featureStatus);
            }
            return jsonResponse({ ok: true });
        });
        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://server.example.test');
    });

    afterEach(async () => {
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl(null);
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        vi.restoreAllMocks();
    });

    it('creates token-only credentials for a supporting server without inventing content keys', async () => {
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');
        const token = tokenForAccount('account-a');

        await expect(buildDataKeyCredentialsForToken(token)).resolves.toEqual({ token });
    });

    it.each([
        ['disabled', { enabled: false }],
        ['missing', undefined],
        ['malformed', { enabled: 'true' }],
    ])('rejects fresh token-only login when plaintext Machine support is %s', async (_label, feature) => {
        plaintextMachineFeature = feature;
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');

        await expect(buildDataKeyCredentialsForToken(tokenForAccount('account-a'))).rejects.toThrow('plaintext Machine');
    });

    it('rejects fresh token-only login against a server without the feature endpoint', async () => {
        featureStatus = 404;
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');

        await expect(buildDataKeyCredentialsForToken(tokenForAccount('account-a'))).rejects.toThrow('plaintext Machine');
    });

    it.each([
        {},
        { secret: 'legacy-secret' },
        { encryption: { publicKey: 'pk', machineKey: 'mk' } },
    ])('preserves existing account key material on token refresh: %j', async (material) => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const existing = { token: tokenForAccount('account-a', 'old-signature'), ...material };
        await expect(TokenStorage.setCredentials(existing)).resolves.toBe(true);
        plaintextMachineFeature = { enabled: false };
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');
        const token = tokenForAccount('account-a', 'new-signature');

        await expect(buildDataKeyCredentialsForToken(token)).resolves.toEqual({ token, ...material });
    });

    it.each([
        { secret: 'other-account-secret' },
        { encryption: { publicKey: 'other-pk', machineKey: 'other-mk' } },
    ])('does not carry another account key material into a new login: %j', async (material) => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentials({ token: tokenForAccount('account-a'), ...material });
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');
        const token = tokenForAccount('account-b');

        await expect(buildDataKeyCredentialsForToken(token)).resolves.toEqual({ token });
    });

    it('rejects a malformed token instead of generating credentials for an unknown account', async () => {
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');

        await expect(buildDataKeyCredentialsForToken('invalid-token')).rejects.toThrow('Invalid token');
    });

    it('does not reuse credentials whose stored account identity cannot be established', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentials({ token: 'invalid-stored-token', secret: 'unknown-account-secret' });
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');
        const token = tokenForAccount('account-a');

        await expect(buildDataKeyCredentialsForToken(token)).resolves.toEqual({ token });
    });

    it('still requires plaintext Machine support when the stored account identity cannot be established', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentials({ token: 'invalid-stored-token', secret: 'unknown-account-secret' });
        plaintextMachineFeature = { enabled: false };
        const { buildDataKeyCredentialsForToken } = await import('./buildDataKeyCredentialsForToken');

        await expect(buildDataKeyCredentialsForToken(tokenForAccount('account-a'))).rejects.toThrow('plaintext Machine');
    });
});
