import { describe, expect, it } from 'vitest';

describe('pendingNotificationNav', () => {
    it('stores and clears the pending payload', async () => {
        const { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } = await import('./pendingNotificationNav');

        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();

        setPendingNotificationNav({ serverUrl: 'https://stack.example.test/', route: '/session/s_1' });
        expect(getPendingNotificationNav()).toEqual({ serverUrl: 'https://stack.example.test', route: '/session/s_1' });

        clearPendingNotificationNav();
        expect(getPendingNotificationNav()).toBeNull();
    });
});

