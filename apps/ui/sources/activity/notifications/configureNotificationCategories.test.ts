import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { configureNotificationCategories } from './configureNotificationCategories';
import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';

const native = vi.hoisted(() => ({ available: true }));
// The optional Expo emitter is the native SDK boundary, not a permission owner.
vi.mock('expo-modules-core', async importOriginal => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => name === 'ExpoNotificationsEmitter'
        ? native.available ? {
            getPendingBackgroundNotificationResponses: async () => [],
            claimBackgroundNotificationResponse: async () => true,
            completeBackgroundNotificationResponse: async () => true,
            addListener: () => ({ remove: () => {} }),
        } : null : actual.requireOptionalNativeModule(name) };
});

describe('native notification categories', () => {
    const originalPlatform = Platform.OS;
    afterEach(() => { Platform.OS = originalPlatform; native.available = true; vi.resetModules(); });

    it('registers external plugin-chosen localized buttons in their own category', async () => {
        const categories = new Map<string, Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]>();
        await configureNotificationCategories({ setNotificationCategoryAsync: async (id, actions) => {
            categories.set(id, actions); return { identifier: id, actions };
        } }, { pluginCategories: [{ pluginId: 'acme.tasks', categoryId: 'review', buttons: [
            { id: 'Show / review', label: { key: 'review.open', fallback: 'Review details' }, effect: { kind: 'open' } },
            { id: 'Ship 🚀', label: 'Ship this', effect: { kind: 'action', invocation: {
                action: { pluginId: 'acme.tasks', localId: 'release' }, input: null } } },
        ] }, { pluginId: 'acme.task-tools', categoryId: 'ready-to-review', buttons: [
            { id: 'Review now', label: 'Review', effect: { kind: 'open' } },
        ] }], resolveLabel: (_pluginId, label) => typeof label === 'string' ? label : 'Localized review' });
        expect(categories.get('happier.pluginNotification.v1/acme.tasks/review')).toEqual([
            { identifier: 'happier.pluginNotification.v1/acme.tasks/review/Show%20%2F%20review', buttonTitle: 'Localized review', options: { opensAppToForeground: true } },
            { identifier: 'happier.pluginNotification.v1/acme.tasks/review/Ship%20%F0%9F%9A%80', buttonTitle: 'Ship this', options: { opensAppToForeground: true } },
        ]);
        expect(categories.get(PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1)?.map(button => button.identifier))
            .toEqual([PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1]);
        // Expo's native contract disallows '-' in category identifiers, not in
        // plugin/category names. The common carrier encoder preserves both.
        expect(categories.has('happier.pluginNotification.v1/acme.task%2Dtools/ready%2Dto%2Dreview')).toBe(true);
    });

    it('serializes plugin and incumbent category updates against the native snapshot owner', async () => {
        let installed = new Map<string, Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]>();
        const notifications = { setNotificationCategoryAsync: async (id: string, actions: Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]) => {
            const snapshot = new Map(installed);
            await Promise.resolve();
            snapshot.set(id, actions); installed = snapshot;
            return { identifier: id, actions };
        } };
        await Promise.all(['acme.one', 'acme.two'].map(pluginId => configureNotificationCategories(notifications, {
            pluginCategories: [{ pluginId, categoryId: 'review', buttons: [{ id: 'open', label: 'Read', effect: { kind: 'open' } }] }],
        })));
        expect([...installed.keys()].sort()).toEqual([...Object.values(PUSH_NOTIFICATION_CATEGORY_IDS),
            'happier.pluginNotification.v1/acme.one/review', 'happier.pluginNotification.v1/acme.two/review'].sort());
    });

    it.each([true, false])('keeps iOS permission buttons authenticated and foregrounds only without native completion support (%s)', async available => {
        native.available = available;
        Platform.OS = 'ios';
        const { configureNotificationCategories: configure } = await import('./configureNotificationCategories');
        const categories = new Map<string, Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]>();
        await configure({ setNotificationCategoryAsync: async (id, actions) => {
            categories.set(id, actions); return { identifier: id, actions };
        } });
        const permission = [...categories.values()].find(actions => actions.some(action => action.identifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1));
        expect(permission?.map(action => action.options)).toEqual([
            { opensAppToForeground: !available, isAuthenticationRequired: true },
            { opensAppToForeground: !available, isAuthenticationRequired: true, isDestructive: true },
        ]);
        const answer = [...categories.values()].flat().find(action => action.identifier === PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1);
        expect(answer?.options?.opensAppToForeground).toBe(true);
        expect(categories.get(PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1)?.map(action => ({
            identifier: action.identifier, buttonTitle: action.buttonTitle, options: action.options,
        }))).toEqual([PUSH_NOTIFICATION_ACTION_IDS.questionChoice1V1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1,
            PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1].map((identifier, index) => ({ identifier, buttonTitle: String(index + 1),
                options: { opensAppToForeground: !available, isAuthenticationRequired: true } })));
        expect(categories.get(PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1)?.[0]).toMatchObject({
            identifier: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1,
            options: { opensAppToForeground: !available, isAuthenticationRequired: true },
            textInput: { submitButtonTitle: expect.stringMatching(/\S/), placeholder: expect.stringMatching(/\S/) },
        });
    });

    it('waits for every native category registration and preserves the complete OS category inventory', async () => {
        Platform.OS = 'ios';
        const { configureNotificationCategories: configure } = await import('./configureNotificationCategories');
        const releases = new Map<string, () => void>();
        let installed = new Map<string, Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]>([['existing_category', []]]);
        let completed = false;
        const configuring = configure({ setNotificationCategoryAsync: async (id, actions) => {
            // SDK55 CategoryManager reads the OS snapshot before awaiting, then replaces that snapshot.
            const snapshot = new Map(installed);
            await new Promise<void>(resolve => { releases.set(id, resolve); });
            snapshot.set(id, actions);
            installed = snapshot;
            return { identifier: id, actions };
        } }).then(() => { completed = true; });
        const expected = [
            PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1,
            PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices1V1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices2V1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1,
            PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1,
            PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1,
        ];
        for (const id of expected) {
            await vi.waitFor(() => expect(releases.has(id)).toBe(true));
            expect(completed).toBe(false);
            releases.get(id)!();
        }
        await configuring;
        expect(completed).toBe(true);
        expect([...installed.keys()].sort()).toEqual(['existing_category', ...expected].sort());
    });

    it('registers both controls for the category emitted by the real Guard producer', async () => {
        const categories = new Map<string, Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]>();
        await configureNotificationCategories({ setNotificationCategoryAsync: async (id, actions) => {
            categories.set(id, actions); return { identifier: id, actions };
        } });
        const payload = buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'm',
            sessionId: 's', rule: 'idle_sessions', stopAt: 300_000 });
        expect(categories.get(payload.categoryId)?.map(action => action.identifier))
            .toEqual([PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1, PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1]);
    });
});
