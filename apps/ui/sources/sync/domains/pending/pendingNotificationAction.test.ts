import { describe, expect, it } from 'vitest';

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
}

describe('pendingNotificationAction', () => {
    it('keeps pending notification actions isolated by active server', async () => {
        const {
            clearPendingNotificationAction,
            getPendingNotificationAction,
            setPendingNotificationAction,
        } = await import('./pendingNotificationAction');

        await activateServer('https://action-a.example.test');
        clearPendingNotificationAction();
        setPendingNotificationAction({
            serverUrl: 'https://action-a.example.test',
            sessionId: 's_a',
            requestId: 'r_a',
            action: 'allow',
        });

        await activateServer('https://action-b.example.test');
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

        await activateServer('https://action-a.example.test');
        expect(getPendingNotificationAction()).toEqual({
            serverUrl: 'https://action-a.example.test',
            sessionId: 's_a',
            requestId: 'r_a',
            action: 'allow',
        });
    });
});
