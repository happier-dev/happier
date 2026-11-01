import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol';
import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { configureNotificationCategories } from './configureNotificationCategories';
import { initializeNotificationBackgroundTask, resetNotificationBackgroundTaskStateForTests } from './notificationBackgroundTaskState';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('notification category platform contract', () => {
    beforeEach(() => resetNotificationBackgroundTaskStateForTests());

    it('retains every category when native setters replace an asynchronously read category snapshot', async () => {
        let registered = new Map<string, Awaited<ReturnType<ExpoNotificationsModule['setNotificationCategoryAsync']>>>([
            ['existing-category', { identifier: 'existing-category', actions: [] }],
        ]);
        // Expo SDK 0.32.16's native category actor can read the same initial OS
        // snapshot in concurrent setters, then replace the entire category set.
        const setCategory = vi.fn<ExpoNotificationsModule['setNotificationCategoryAsync']>().mockImplementation(async (identifier, actions) => {
            const snapshot = new Map(registered);
            await Promise.resolve();
            const category = { identifier, actions };
            snapshot.set(identifier, category);
            registered = snapshot;
            return category;
        });

        await configureNotificationCategories({ setNotificationCategoryAsync: setCategory }, 'ios');

        expect([...registered.keys()].sort()).toEqual([
            'existing-category',
            PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1,
            PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices1V1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices2V1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1,
        ].sort());
    });

    it('waits for native registration and reports a failed category update', async () => {
        let finish!: () => void;
        const registered = new Promise<Awaited<ReturnType<ExpoNotificationsModule['setNotificationCategoryAsync']>>>((resolve) => {
            finish = () => resolve({ identifier: 'registered', actions: [] });
        });
        const setCategory = vi.fn<ExpoNotificationsModule['setNotificationCategoryAsync']>().mockReturnValue(registered);
        let settled = false;
        const configuring = configureNotificationCategories({ setNotificationCategoryAsync: setCategory }, 'ios').then(() => { settled = true; });
        await vi.waitFor(() => expect(setCategory).toHaveBeenCalled());
        expect(settled).toBe(false);
        finish();
        await configuring;

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            setCategory.mockRejectedValue(new Error('native registration failed'));
            await configureNotificationCategories({ setNotificationCategoryAsync: setCategory }, 'ios');
            expect(warn).toHaveBeenCalled();
        } finally { warn.mockRestore(); }
    });

    it('requires unlock for iOS decisions, keeps Answer foreground, and enables background only with a native handler', async () => {
        const setCategory = vi.fn<ExpoNotificationsModule['setNotificationCategoryAsync']>().mockImplementation(async (identifier, actions) => ({ identifier, actions }));
        const notifications = { setNotificationCategoryAsync: setCategory };
        await configureNotificationCategories(notifications, 'ios');
        expect(setCategory.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, options: { opensAppToForeground: true, isAuthenticationRequired: true } }),
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1, options: { opensAppToForeground: true, isAuthenticationRequired: true, isDestructive: true } }),
        ]);
        await initializeNotificationBackgroundTask('ios', () => ({ registerNotificationBackgroundTask: async () => true }));
        setCategory.mockClear();
        await configureNotificationCategories(notifications, 'ios');
        const permissions = setCategory.mock.calls.find(([category]) => category === PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1)?.[1];
        expect(permissions?.map((action) => action.options)).toEqual([
            { opensAppToForeground: false, isAuthenticationRequired: true },
            { opensAppToForeground: false, isAuthenticationRequired: true, isDestructive: true },
        ]);
        expect(setCategory.mock.calls.find(([category]) => category === PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1)?.[1]).toEqual([
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, options: { opensAppToForeground: true } }),
        ]);
        expect(setCategory.mock.calls.find(([category]) => category === PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1)?.[1]).toEqual([
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.questionChoice1V1, buttonTitle: '1', options: { opensAppToForeground: false, isAuthenticationRequired: true } }),
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1, buttonTitle: '2', options: { opensAppToForeground: false, isAuthenticationRequired: true } }),
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1, buttonTitle: '3', options: { opensAppToForeground: false, isAuthenticationRequired: true } }),
        ]);
        expect(setCategory.mock.calls.find(([category]) => category === PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1)?.[1]).toEqual([
            expect.objectContaining({ identifier: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1,
                options: { opensAppToForeground: false, isAuthenticationRequired: true },
                textInput: { submitButtonTitle: expect.any(String), placeholder: expect.any(String) } }),
        ]);
    });
});
