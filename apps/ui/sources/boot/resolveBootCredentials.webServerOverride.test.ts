// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveBootCredentials } from './resolveBootCredentials';

installTokenStorageWebPlatformMocks();

describe('web Home intent boot admission', () => {
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(() => {
        storage = installLocalStorageMock();
        locks = installWebLockManagerMock();
        vi.stubGlobal('window', {
            localStorage: globalThis.localStorage,
            location: { href: 'https://app.example.test/?server=https%3A%2F%2Fsupplied.example.test' },
            history: { replaceState: vi.fn() },
        });
    });

    afterEach(() => {
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
    });

    it('keeps retained credentials persisted but excludes them from an unknown Home boot', async () => {
        const retained = await upsertAndActivateServer({ serverUrl: 'https://retained.example.test', source: 'manual', scope: 'device' });
        const credentials = { token: 'retained-home-token' };
        expect(await TokenStorage.setCredentials(credentials)).toBe(true);

        await expect(resolveBootCredentials('web')).resolves.toBeNull();

        expect(profiles.getActiveServerSnapshot().serverId).toBe(retained.id);
        expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === 'https://supplied.example.test')).toBe(false);
        await expect(TokenStorage.getCredentialsForServerUrl(retained.serverUrl, { serverId: retained.id })).resolves.toEqual(credentials);
    });
});
