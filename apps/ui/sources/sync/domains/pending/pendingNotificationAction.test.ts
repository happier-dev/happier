import { describe, expect, it } from 'vitest';
import type { StorageState } from '@/sync/store/types';

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    const server = upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
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
});
