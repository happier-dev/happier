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

describe('pendingNotificationNav', () => {
    it('stores and clears the pending payload', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        await activateServerAccount('https://stack.example.test', 'account-a');
        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();

        setPendingNotificationNav({ serverUrl: 'https://stack.example.test/', serverId: 'server-profile', route: '/session/s_1?serverId=server-profile' });
        expect(getPendingNotificationNav()).toEqual({
            serverUrl: 'https://stack.example.test',
            serverId: 'server-profile',
            route: '/session/s_1?serverId=server-profile',
        });

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

        const legacyProfile = await upsertAndActivateServer({ serverUrl: 'https://notify-nav.example.test', scope: 'device', source: 'manual' });
        const legacyScope = createServerAccountScope(legacyProfile.id, 'account-a');
        expect(legacyScope).not.toBeNull();
        if (!legacyScope) return;

        await activateScope(legacyScope);
        mod.clearPendingNotificationNav();
        mod.setPendingNotificationNav({ serverUrl: 'https://notify-nav.example.test', route: '/session/s_legacy' });

        await setServerProfileIdentityForUrl('https://notify-nav.example.test', 'srv_notify_nav_identity');
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

    it('rehydrates cross-server pending navigation before the target account scope is active', async () => {
        const mod = await import('./pendingNotificationNav');

        await activateServerAccount('https://nav-source.example.test', 'account-a');
        mod.clearPendingNotificationNav();
        mod.setPendingNotificationNav({
            serverUrl: 'https://nav-target.example.test',
            route: '/session/s_cross',
        });

        expect(mod.getPendingNotificationNav()).toBeNull();

        await activateServerWithoutAccount('https://nav-target.example.test');
        expect(mod.getPendingNotificationNav()).toEqual({
            serverUrl: 'https://nav-target.example.test',
            route: '/session/s_cross',
        });

        mod.clearPendingNotificationNav();
        expect(mod.getPendingNotificationNav()).toBeNull();
    });

    it('does not promote server-scoped pending navigation into an active account scope', async () => {
        const mod = await import('./pendingNotificationNav');

        await activateServerWithoutAccount('https://nav-shared-fallback.example.test');
        mod.clearPendingNotificationNav();
        mod.setPendingNotificationNav({
            serverUrl: 'https://nav-shared-fallback.example.test',
            route: '/session/s_server_scoped',
        });

        expect(mod.getPendingNotificationNav()).toEqual({
            serverUrl: 'https://nav-shared-fallback.example.test',
            route: '/session/s_server_scoped',
        });

        await activateServerAccount('https://nav-shared-fallback.example.test', 'account-b');
        expect(mod.getPendingNotificationNav()).toBeNull();
    });
});
