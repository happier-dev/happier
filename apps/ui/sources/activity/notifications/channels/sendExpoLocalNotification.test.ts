import { beforeEach, describe, expect, it, vi } from 'vitest';

const scheduleNotificationAsync = vi.hoisted(() => vi.fn(async () => 'notif-1'));

vi.mock('expo-notifications', () => ({
    scheduleNotificationAsync,
}));

describe('sendExpoLocalNotification', () => {
    beforeEach(() => {
        scheduleNotificationAsync.mockClear();
    });

    it('schedules an immediate local notification with navigation data', async () => {
        const { sendExpoLocalNotification } = await import('./sendExpoLocalNotification');

        await sendExpoLocalNotification({
            title: 'Session ready',
            body: 'Codex finished the turn.',
            data: { sessionId: 'session-1' },
            categoryIdentifier: 'ready_category',
        });

        expect(scheduleNotificationAsync).toHaveBeenCalledWith({
            content: {
                title: 'Session ready',
                body: 'Codex finished the turn.',
                data: { sessionId: 'session-1' },
                categoryIdentifier: 'ready_category',
                sound: 'default',
            },
            trigger: null,
        });
    });
});
