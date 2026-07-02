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

describe('pendingNotificationAction', () => {
    it('keeps pending notification actions isolated by active server', async () => {
        const {
            clearPendingNotificationAction,
            getPendingNotificationAction,
            setPendingNotificationAction,
        } = await import('./pendingNotificationAction');

        await activateServerAccount('https://action-a.example.test', 'account-a');
        clearPendingNotificationAction();
        setPendingNotificationAction({
            serverUrl: 'https://action-a.example.test',
            sessionId: 's_a',
            requestId: 'r_a',
            action: 'allow',
        });

        await activateServerAccount('https://action-b.example.test', 'account-a');
        clearPendingNotificationAction();
        expect(getPendingNotificationAction()).toBeNull();
        setPendingNotificationAction({
            serverUrl: 'https://action-b.example.test',
            sessionId: 's_b',
            requestId: 'r_b',
            action: 'deny',
        });

        expect(getPendingNotificationAction()).toEqual({
            serverUrl: 'https://action-b.example.test',
            sessionId: 's_b',
            requestId: 'r_b',
            action: 'deny',
        });

        await activateServerAccount('https://action-a.example.test', 'account-a');
        expect(getPendingNotificationAction()).toEqual({
            serverUrl: 'https://action-a.example.test',
            sessionId: 's_a',
            requestId: 'r_a',
            action: 'allow',
        });
    });

    it('keeps pending notification actions isolated by active account on the same server', async () => {
        const {
            clearPendingNotificationAction,
            getPendingNotificationAction,
            setPendingNotificationAction,
        } = await import('./pendingNotificationAction');

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingNotificationAction();
        setPendingNotificationAction({
            serverUrl: 'https://shared.example.test',
            sessionId: 's_a',
            requestId: 'r_a',
            action: 'allow',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingNotificationAction();
        expect(getPendingNotificationAction()).toBeNull();
        setPendingNotificationAction({
            serverUrl: 'https://shared.example.test',
            sessionId: 's_b',
            requestId: 'r_b',
            action: 'deny',
        });

        expect(getPendingNotificationAction()).toEqual({
            serverUrl: 'https://shared.example.test',
            sessionId: 's_b',
            requestId: 'r_b',
            action: 'deny',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingNotificationAction()).toEqual({
            serverUrl: 'https://shared.example.test',
            sessionId: 's_a',
            requestId: 'r_a',
            action: 'allow',
        });
    });

    it('migrates host-derived legacy notification actions into the identity scope idempotently', async () => {
        const mod = await import('./pendingNotificationAction');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');

        const legacyProfile = upsertAndActivateServer({ serverUrl: 'https://notify.example.test', scope: 'device', source: 'manual' });
        const legacyScope = createServerAccountScope(legacyProfile.id, 'account-a');
        expect(legacyScope).not.toBeNull();
        if (!legacyScope) return;

        await activateScope(legacyScope);
        mod.clearPendingNotificationAction();
        mod.setPendingNotificationAction({
            serverUrl: 'https://notify.example.test',
            sessionId: 's_legacy',
            requestId: 'r_legacy',
            action: 'allow',
        });

        setServerProfileIdentityForUrl('https://notify.example.test', 'srv_notify_identity');
        const identityScope = createServerAccountScope('srv_notify_identity', 'account-a');
        expect(identityScope).not.toBeNull();
        if (!identityScope) return;

        await activateScope(identityScope);
        mod.migratePendingNotificationActionScopes(identityScope, [legacyScope]);
        expect(mod.getPendingNotificationAction()).toEqual({
            serverUrl: 'https://notify.example.test',
            sessionId: 's_legacy',
            requestId: 'r_legacy',
            action: 'allow',
        });

        mod.migratePendingNotificationActionScopes(identityScope, [legacyScope]);
        expect(mod.getPendingNotificationAction()).toEqual({
            serverUrl: 'https://notify.example.test',
            sessionId: 's_legacy',
            requestId: 'r_legacy',
            action: 'allow',
        });
    });
});
