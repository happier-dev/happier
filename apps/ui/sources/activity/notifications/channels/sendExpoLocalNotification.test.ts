import { beforeEach, describe, expect, it, vi } from 'vitest';

const scheduleNotificationAsync = vi.hoisted(() => vi.fn(async () => 'notif-1'));
const notificationNativeState = vi.hoisted(() => ({ unavailable: false }));

vi.mock('expo-notifications', () => {
    if (notificationNativeState.unavailable) {
        throw new Error('expo-notifications native module unavailable');
    }
    return {
        scheduleNotificationAsync,
    };
});

describe('sendExpoLocalNotification', () => {
    beforeEach(() => {
        vi.resetModules();
        notificationNativeState.unavailable = false;
        scheduleNotificationAsync.mockClear();
    });

    it('does not load expo-notifications while importing the channel module', async () => {
        notificationNativeState.unavailable = true;

        await expect(import('./sendExpoLocalNotification')).resolves.toHaveProperty('sendExpoLocalNotification');
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

    it('omits the notification sound when the resolved delivery plan is silent', async () => {
        const { sendExpoLocalNotification } = await import('./sendExpoLocalNotification');

        await sendExpoLocalNotification({
            title: 'Session ready',
            body: 'Codex finished the turn.',
            data: { sessionId: 'session-1' },
            sound: null,
        });

        expect(scheduleNotificationAsync).toHaveBeenCalledWith({
            content: {
                title: 'Session ready',
                body: 'Codex finished the turn.',
                data: { sessionId: 'session-1' },
            },
            trigger: null,
        });
    });

    it('omits the native category field when no category is provided', async () => {
        const { sendExpoLocalNotification } = await import('./sendExpoLocalNotification');

        await sendExpoLocalNotification({
            title: 'Session ready',
            body: 'Codex finished the turn.',
            data: { sessionId: 'session-1' },
            categoryIdentifier: null as unknown as string,
        });

        expect(scheduleNotificationAsync).toHaveBeenCalledWith({
            content: {
                title: 'Session ready',
                body: 'Codex finished the turn.',
                data: { sessionId: 'session-1' },
                sound: 'default',
            },
            trigger: null,
        });
    });

    it('omits the native category field when the category is blank', async () => {
        const { sendExpoLocalNotification } = await import('./sendExpoLocalNotification');

        await sendExpoLocalNotification({
            title: 'Session ready',
            body: 'Codex finished the turn.',
            data: { sessionId: 'session-1' },
            categoryIdentifier: '   ',
        });

        expect(scheduleNotificationAsync).toHaveBeenCalledWith({
            content: {
                title: 'Session ready',
                body: 'Codex finished the turn.',
                data: { sessionId: 'session-1' },
                sound: 'default',
            },
            trigger: null,
        });
    });

    it('uses an Android channel-aware trigger when a channel id is provided', async () => {
        const { sendExpoLocalNotification } = await import('./sendExpoLocalNotification');

        await sendExpoLocalNotification({
            title: 'Session ready',
            body: 'Codex finished the turn.',
            data: { sessionId: 'session-1' },
            sound: 'happier_soft.wav',
            channelId: 'happier.default.soft.v1',
        });

        expect(scheduleNotificationAsync).toHaveBeenCalledWith({
            content: {
                title: 'Session ready',
                body: 'Codex finished the turn.',
                data: { sessionId: 'session-1' },
                sound: 'happier_soft.wav',
            },
            trigger: { channelId: 'happier.default.soft.v1' },
        });
    });
});
