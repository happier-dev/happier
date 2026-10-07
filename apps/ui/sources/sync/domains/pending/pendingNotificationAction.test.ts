import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

beforeAll(loadSyncSingletonForTests);

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');

    const server = await upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    if (!scope) throw new Error('Expected Account scope');
    await activateScope(scope);
}

async function activateScope(scope: { serverId: string; accountId: string }) {
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const { storage } = await import('@/sync/domains/state/storage');
    await switchConnectionToActiveServer();
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
}

async function activateServerWithoutAccount(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const { storage } = await import('@/sync/domains/state/storage');

    await upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
    await switchConnectionToActiveServer();
    storage.getState().clearProfileScope();
    storage.getState().clearSettingsScope();
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
            serverId: 'server-a-profile',
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
            serverId: 'server-a-profile',
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

        const legacyProfile = await upsertAndActivateServer({ serverUrl: 'https://notify.example.test', scope: 'device', source: 'manual' });
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

        await setServerProfileIdentityForUrl('https://notify.example.test', 'srv_notify_identity');
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

    it('rehydrates cross-server pending notification actions before the target account scope is active', async () => {
        const mod = await import('./pendingNotificationAction');

        await activateServerAccount('https://action-source.example.test', 'account-a');
        mod.clearPendingNotificationAction();
        mod.setPendingNotificationAction({
            serverUrl: 'https://action-target.example.test',
            sessionId: 's_cross',
            requestId: 'r_cross',
            action: 'deny',
        });

        expect(mod.getPendingNotificationAction()).toBeNull();

        await activateServerWithoutAccount('https://action-target.example.test');
        expect(mod.getPendingNotificationAction()).toEqual({
            serverUrl: 'https://action-target.example.test',
            sessionId: 's_cross',
            requestId: 'r_cross',
            action: 'deny',
        });

        mod.clearPendingNotificationAction();
        expect(mod.getPendingNotificationAction()).toBeNull();
    });

    it('does not promote server-scoped pending notification actions into an active account scope', async () => {
        const mod = await import('./pendingNotificationAction');

        await activateServerWithoutAccount('https://action-shared-fallback.example.test');
        mod.clearPendingNotificationAction();
        mod.setPendingNotificationAction({
            serverUrl: 'https://action-shared-fallback.example.test',
            sessionId: 's_server_scoped',
            requestId: 'r_server_scoped',
            action: 'allow',
        });

        expect(mod.getPendingNotificationAction()).toEqual({
            serverUrl: 'https://action-shared-fallback.example.test',
            sessionId: 's_server_scoped',
            requestId: 'r_server_scoped',
            action: 'allow',
        });

        await activateServerAccount('https://action-shared-fallback.example.test', 'account-b');
        expect(mod.getPendingNotificationAction()).toBeNull();
    });
});
