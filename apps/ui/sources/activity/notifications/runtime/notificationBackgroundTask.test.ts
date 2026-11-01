import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';

const native = vi.hoisted(() => ({
    defined: false,
    available: true,
    execute: null as null | ((body: unknown) => Promise<void>),
    define: vi.fn(),
    register: vi.fn(async () => {}),
}));
vi.mock('expo-task-manager', () => ({
    isTaskDefined: () => native.defined,
    defineTask: (name: string, execute: (body: unknown) => Promise<void>) => {
        native.define(name);
        native.execute = execute;
        native.defined = true;
    },
    isAvailableAsync: async () => native.available,
}));
vi.mock('expo-notifications', () => ({ registerTaskAsync: native.register }));

describe('notification native task adapter', () => {
    beforeEach(() => {
        vi.resetModules();
        native.defined = false;
        native.available = true;
        native.execute = null;
        native.define.mockClear();
        native.register.mockReset().mockResolvedValue(undefined);
    });

    it('defines at module load, before registration, and handles receipts without executing an action', async () => {
        const task = await import('./notificationBackgroundTask');
        expect(native.define).toHaveBeenCalledWith(task.NOTIFICATION_BACKGROUND_TASK_NAME);
        expect(native.register).not.toHaveBeenCalled();
        await native.execute?.({ data: { notification: null, data: { dataString: '{}' } } });
        await expect(task.registerNotificationBackgroundTask()).resolves.toBe(true);
        expect(native.register).toHaveBeenCalledWith(task.NOTIFICATION_BACKGROUND_TASK_NAME);
    });

    it('does not register when the native task manager is unavailable', async () => {
        native.available = false;
        const task = await import('./notificationBackgroundTask');
        await expect(task.registerNotificationBackgroundTask()).resolves.toBe(false);
        expect(native.register).not.toHaveBeenCalled();
    });

    it('keeps valid cold loading alive beyond the optional SDK load budget', async () => {
        const { runNotificationBackgroundTask } = await import('./notificationBackgroundTask');
        const actions = await import('./notificationPermissionActionExecution');
        const { consumeNotificationPermissionRecoveryNeeded } = await import('./notificationPermissionRecovery');
        consumeNotificationPermissionRecoveryNeeded();
        let release!: () => void;
        const stalled = new Promise<typeof actions>((resolve) => { release = () => resolve(actions); });
        vi.useFakeTimers();
        try {
            // This malformed action would mark recovery if the real handler ran late.
            const pending = runNotificationBackgroundTask({ data: { actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1 } }, { importExecution: () => stalled });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS + 1_436);
            expect(settled).toBe(false);
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
            release();
            await pending;
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
        } finally { vi.useRealTimers(); }
    });

    it('persists a recovery signal for task failures without logging their payload', async () => {
        await import('./notificationBackgroundTask');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await native.execute?.({ data: null, error: { message: 'sensitive-body' } });
            const { consumeNotificationPermissionRecoveryNeeded } = await import('./notificationPermissionRecovery');
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
            expect(warn.mock.calls.flat().join(' ')).not.toContain('sensitive-body');
        } finally { warn.mockRestore(); }
    });
});
