import { afterEach, describe, expect, it, vi } from 'vitest';

import { installBrowserNotificationApiStub } from '@/dev/testkit/mocks/browserNotification';

import { requestWebLocalNotificationPermission, sendWebLocalNotification } from './sendWebLocalNotification';

describe('sendWebLocalNotification', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shows a system notification when the browser already granted permission', async () => {
        const browser = installBrowserNotificationApiStub('granted');

        const sent = await sendWebLocalNotification({ title: 'Ready session', body: 'Everything is ready.', tag: 'session-1' });

        expect(sent).toBe(true);
        expect(browser.shown).toHaveLength(1);
        expect(browser.shown[0]).toMatchObject({
            title: 'Ready session',
            options: { body: 'Everything is ready.', tag: 'session-1' },
        });
    });

    it.each(['default', 'denied'] as const)('never prompts or shows a notification while permission is %s', async (permission) => {
        const browser = installBrowserNotificationApiStub(permission);

        await expect(sendWebLocalNotification({ title: 'Ready session', body: 'Done.' })).resolves.toBe(false);

        expect(browser.shown).toHaveLength(0);
        expect(browser.requestPermission).not.toHaveBeenCalled();
    });

    it('focuses the page, closes the notification, and opens its target when clicked', async () => {
        const browser = installBrowserNotificationApiStub('granted');
        const focus = vi.fn();
        vi.stubGlobal('focus', focus);
        const onClick = vi.fn();

        await sendWebLocalNotification({ title: 'Ready session', body: 'Done.', onClick });
        browser.shown[0].onclick?.();

        expect(focus).toHaveBeenCalledTimes(1);
        expect(browser.shown[0].close).toHaveBeenCalledTimes(1);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('asks for permission only while the browser has not decided yet', async () => {
        const undecided = installBrowserNotificationApiStub('default');
        await requestWebLocalNotificationPermission();
        expect(undecided.requestPermission).toHaveBeenCalledTimes(1);

        const denied = installBrowserNotificationApiStub('denied');
        await requestWebLocalNotificationPermission();
        expect(denied.requestPermission).not.toHaveBeenCalled();
    });

    it('does nothing where the browser has no Notification API', async () => {
        vi.stubGlobal('Notification', undefined);

        await expect(sendWebLocalNotification({ title: 'Ready session', body: 'Done.' })).resolves.toBe(false);
        await expect(requestWebLocalNotificationPermission()).resolves.toBeUndefined();
    });
});
