import { describe, expect, it } from 'vitest';
import type { StorageState } from '@/sync/store/types';

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    const server = upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    registerStorageStateReader(() => ({ profileScope: scope } as unknown as StorageState));
}

async function activateScope(scope: { serverId: string; accountId: string }) {
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => ({ profileScope: scope } as unknown as StorageState));
}

describe('pendingNotificationNav', () => {
    it('stores and clears the pending payload', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        await activateServerAccount('https://stack.example.test', 'account-a');
        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();

        setPendingNotificationNav({ serverUrl: 'https://stack.example.test/', route: '/session/s_1' });
        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://stack.example.test', route: '/session/s_1' });

        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();
    });

    it('keeps pending navigation isolated by active server', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        await activateServerAccount('https://nav-a.example.test', 'account-a');
        clearPendingNotificationNav();
        setPendingNotificationNav({ serverUrl: 'https://nav-a.example.test', route: '/session/s_a' });

        await activateServerAccount('https://nav-b.example.test', 'account-a');
        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();
        setPendingNotificationNav({ serverUrl: 'https://nav-b.example.test', route: '/session/s_b' });

        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://nav-b.example.test', route: '/session/s_b' });

        await activateServerAccount('https://nav-a.example.test', 'account-a');
        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://nav-a.example.test', route: '/session/s_a' });
    });

    it('keeps pending navigation isolated by active account on the same server', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingNotificationNav();
        setPendingNotificationNav({ serverUrl: 'https://shared.example.test', route: '/session/s_a' });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();
        setPendingNotificationNav({ serverUrl: 'https://shared.example.test', route: '/session/s_b' });

        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://shared.example.test', route: '/session/s_b' });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://shared.example.test', route: '/session/s_a' });
    });

    it('migrates host-derived legacy notification navigation into the identity scope idempotently', async () => {
        const mod = await import('./pendingNotificationNav');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');

        const legacyProfile = upsertAndActivateServer({ serverUrl: 'https://notify-nav.example.test', scope: 'device', source: 'manual' });
        const legacyScope = createServerAccountScope(legacyProfile.id, 'account-a');
        expect(legacyScope).not.toBeNull();
        if (!legacyScope) return;

        await activateScope(legacyScope);
        mod.clearPendingNotificationNav();
        mod.setPendingNotificationNav({ serverUrl: 'https://notify-nav.example.test', route: '/session/s_legacy' });

        setServerProfileIdentityForUrl('https://notify-nav.example.test', 'srv_notify_nav_identity');
        const identityScope = createServerAccountScope('srv_notify_nav_identity', 'account-a');
        expect(identityScope).not.toBeNull();
        if (!identityScope) return;

        await activateScope(identityScope);
        mod.migratePendingNotificationNavScopes(identityScope, [legacyScope]);
        expect(mod.getPendingNotificationNav()).toEqual({
            serverUrl: 'https://notify-nav.example.test',
            route: '/session/s_legacy',
        });

        mod.migratePendingNotificationNavScopes(identityScope, [legacyScope]);
        expect(mod.getPendingNotificationNav()).toEqual({
            serverUrl: 'https://notify-nav.example.test',
            route: '/session/s_legacy',
        });
    });
});
