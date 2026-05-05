import { describe, expect, it } from 'vitest';

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
}

describe('pendingNotificationNav', () => {
    it('stores and clears the pending payload', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        await activateServer('https://stack.example.test');
        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();

        setPendingNotificationNav({ serverUrl: 'https://stack.example.test/', route: '/session/s_1' });
        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://stack.example.test', route: '/session/s_1' });

        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();
    });

    it('keeps pending navigation isolated by active server', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        await activateServer('https://nav-a.example.test');
        clearPendingNotificationNav();
        setPendingNotificationNav({ serverUrl: 'https://nav-a.example.test', route: '/session/s_a' });

        await activateServer('https://nav-b.example.test');
        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();
        setPendingNotificationNav({ serverUrl: 'https://nav-b.example.test', route: '/session/s_b' });

        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://nav-b.example.test', route: '/session/s_b' });

        await activateServer('https://nav-a.example.test');
        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://nav-a.example.test', route: '/session/s_a' });
    });
});
