import { beforeEach, describe, expect, it, vi } from 'vitest';

const isPermissionGranted = vi.hoisted(() => vi.fn(async () => false));
const requestPermission = vi.hoisted(() => vi.fn(async () => 'granted'));
const sendNotification = vi.hoisted(() => vi.fn());

vi.mock('./tauriNotificationPlugin', () => ({
    isPermissionGranted,
    requestPermission,
    sendNotification,
}));

describe('sendTauriLocalNotification', () => {
    beforeEach(() => {
        isPermissionGranted.mockClear();
        requestPermission.mockClear();
        sendNotification.mockClear();
    });

    it('requests permission before sending when needed', async () => {
        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');

        const sent = await sendTauriLocalNotification({
            title: 'Permission request',
            body: 'A session needs approval.',
        });

        expect(sent).toBe(true);
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(sendNotification).toHaveBeenCalledWith({
            title: 'Permission request',
            body: 'A session needs approval.',
        });
    });

    it('does not send when permission remains denied', async () => {
        requestPermission.mockResolvedValueOnce('denied');

        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');

        const sent = await sendTauriLocalNotification({
            title: 'Permission request',
            body: 'A session needs approval.',
        });

        expect(sent).toBe(false);
        expect(sendNotification).not.toHaveBeenCalled();
    });
});
