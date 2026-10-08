import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

installTokenStorageWebPlatformMocks();
let storageBoundary: ReturnType<typeof installLocalStorageMock>;
let locksBoundary: ReturnType<typeof installWebLockManagerMock>;

describe('apiPush endpoint supervision', () => {
    beforeEach(() => {
        storageBoundary = installLocalStorageMock();
        locksBoundary = installWebLockManagerMock();
    });

    afterEach(async () => {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        runtimeFetchMock.mockReset();
        locksBoundary.restore();
        storageBoundary.restore();
        vi.unstubAllGlobals();
        vi.resetModules();
        vi.useRealTimers();
    });

    it('does not use raw global fetch when apiEndpoint is provided', async () => {
        const globalFetch = vi.fn(() => {
            throw new Error('raw global fetch should not be called');
        });
        vi.stubGlobal('fetch', globalFetch);

        runtimeFetchMock.mockImplementation(async (url: unknown) => {
            const asString = String(url ?? '');
            if (asString.endsWith('/v1/push-tokens')) {
                return new Response(JSON.stringify({ success: true }), { status: 200, headers: new Headers() });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
        });

        const { registerPushToken } = await import('./apiPush');

        await expect(
            registerPushToken(
                { token: 'token-1', secret: 'secret' },
                'push-token-1',
                { apiEndpoint: 'https://other.example.test', clientServerUrl: 'https://client.example.test' },
            ),
        ).resolves.toBeUndefined();

        expect(globalFetch).toHaveBeenCalledTimes(0);
        expect(runtimeFetchMock).toHaveBeenCalled();
    });

    it('uses the provided serverId when supervising an explicit apiEndpoint', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const home = await upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'server-123' });
        const targetToken = createAccountTokenForTests('token-1');
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: targetToken })).toBe(true);
        runtimeFetchMock.mockImplementation(async (url: unknown) => {
            const asString = String(url ?? '');
            if (asString.endsWith('/v1/push-tokens')) {
                return new Response(JSON.stringify({ success: true }), { status: 200, headers: new Headers() });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
        });

        const { registerPushToken } = await import('./apiPush');

        await expect(
            registerPushToken(
                { token: 'token-1', secret: 'secret' },
                'push-token-1',
                {
                    serverId: home.id,
                    apiEndpoint: 'https://other.example.test',
                    clientServerUrl: 'https://client.example.test',
                    retry: 'none',
                },
            ),
        ).resolves.toBeUndefined();

        const registrations = runtimeFetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/push-tokens'));
        expect(registrations).toHaveLength(1);
        expect(new Headers(registrations[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${targetToken}`);
    });
});
