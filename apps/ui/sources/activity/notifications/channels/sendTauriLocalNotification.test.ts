import { beforeEach, describe, expect, it, vi } from 'vitest';

const isPermissionGranted = vi.hoisted(() => vi.fn(async () => false));
const requestPermission = vi.hoisted(() => vi.fn(async () => 'granted'));
const sendNotification = vi.hoisted(() => vi.fn());
const invokeTauri = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@/utils/platform/tauri', () => ({ invokeTauri }));

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
        invokeTauri.mockReset().mockResolvedValue(false);
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
    it('preserves notification data through the native clickable channel', async () => {
        invokeTauri.mockResolvedValueOnce(true);
        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');
        const data = { sessionId: 'session-1', serverUrl: 'https://home.example', accountId: 'account-1' };
        expect(await sendTauriLocalNotification({ title: 'Ready', body: 'Finished', data })).toBe(true);
        expect(invokeTauri).toHaveBeenCalledWith('desktop_show_clickable_notification', {
            title: 'Ready', body: 'Finished', data,
        });
        expect(sendNotification).not.toHaveBeenCalled();
    });

    it('reports a native delivery failure before using the plugin fallback', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        invokeTauri.mockRejectedValueOnce(new Error('native delivery unavailable'));
        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');
        expect(await sendTauriLocalNotification({ title: 'Ready', body: 'Finished' })).toBe(true);
        expect(warning).toHaveBeenCalled();
        expect(sendNotification).toHaveBeenCalledWith({ title: 'Ready', body: 'Finished' });
        warning.mockRestore();
    });

});
