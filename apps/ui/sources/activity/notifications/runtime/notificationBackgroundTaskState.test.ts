import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';
import { PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS } from '../permission/pushNotificationAccess';
import { initializeNotificationBackgroundTask, notificationPermissionActionsOpenApp, resetNotificationBackgroundTaskStateForTests } from './notificationBackgroundTaskState';

describe('Native background action capability', () => {
    beforeEach(() => { resetNotificationBackgroundTaskStateForTests(); vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it.each(['web'])('does not load optional native modules on %s', async (platform) => {
        const load = vi.fn(() => { throw new Error('native module absent'); });
        await expect(initializeNotificationBackgroundTask(platform, load)).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp(platform)).resolves.toBe(true);
        expect(load).not.toHaveBeenCalled();
    });

    it('keeps iOS actions foreground until its native completion handler is installed', async () => {
        await expect(notificationPermissionActionsOpenApp('ios')).resolves.toBe(true);
        await expect(initializeNotificationBackgroundTask('ios', () => ({
            registerNotificationBackgroundTask: async () => true,
        }))).resolves.toBe(true);
        await expect(notificationPermissionActionsOpenApp('ios')).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(true);
    });

    it('keeps iOS actions foreground on older native binaries', async () => {
        await expect(initializeNotificationBackgroundTask('ios', () => ({
            registerNotificationBackgroundTask: async () => false,
        }))).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp('ios')).resolves.toBe(true);
    });

    it('defines synchronously, registers once, and only changes Android foregrounding', async () => {
        const register = vi.fn(async () => true);
        const load = vi.fn(() => ({ registerNotificationBackgroundTask: register }));
        const first = initializeNotificationBackgroundTask('android', load);
        expect(load).toHaveBeenCalledTimes(1);
        expect(initializeNotificationBackgroundTask('android', load)).toBe(first);
        await expect(first).resolves.toBe(true);
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp('ios')).resolves.toBe(true);
        expect(register).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps foreground actions if the module is absent or registration fails', async () => {
        await expect(initializeNotificationBackgroundTask('android', () => { throw new Error('absent'); })).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(true);
        resetNotificationBackgroundTaskStateForTests();
        await expect(initializeNotificationBackgroundTask('android', () => ({ registerNotificationBackgroundTask: async () => false }))).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(true);
        resetNotificationBackgroundTaskStateForTests();
        await expect(initializeNotificationBackgroundTask('android', () => ({ registerNotificationBackgroundTask: async () => { throw new Error('native'); } }))).resolves.toBe(false);
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(true);
    });

    it('bounds a hung registration, ignores late success, and resets the promise between runtimes', async () => {
        let complete!: (value: boolean) => void;
        const pending = initializeNotificationBackgroundTask('android', () => ({
            registerNotificationBackgroundTask: () => new Promise((resolve) => { complete = resolve; }),
        }));
        await vi.advanceTimersByTimeAsync(EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS);
        await expect(pending).resolves.toBe(false);
        complete(true);
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(true);
        resetNotificationBackgroundTaskStateForTests();
        await expect(notificationPermissionActionsOpenApp('android')).resolves.toBe(true);
        await expect(initializeNotificationBackgroundTask('android', () => ({ registerNotificationBackgroundTask: async () => true }))).resolves.toBe(true);
    });

    it('uses the notification native-call budget for a stalled registration', async () => {
        let complete!: (value: boolean) => void;
        const pending = initializeNotificationBackgroundTask('android', () => ({
            registerNotificationBackgroundTask: () => new Promise((resolve) => { complete = resolve; }),
        }));
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS);
        expect(settled).toBe(true);
        complete(true);
        await expect(pending).resolves.toBe(false);
    });
});
