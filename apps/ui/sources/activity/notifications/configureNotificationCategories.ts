import { PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS, buildPluginNotificationCategoryId, buildPluginNotificationButtonId } from '@happier-dev/protocol/push/pushNotificationActions';
import type { PluginDeclarativeButtonV1 } from '@happier-dev/protocol/plugins/contributions/declarativeButtonsV1';
import { t } from '@/text';
import { initializeIOSNotificationBackgroundResponses } from './runtime/iosNotificationBackgroundResponses';
import { Platform } from 'react-native';
import { syncSessionChangedBackgroundWakeTaskRegistration } from './backgroundWake/defineSessionChangedBackgroundWakeTask';

import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';

export type PluginNativeCategory = Readonly<{ pluginId: string; categoryId: string; buttons: readonly PluginDeclarativeButtonV1[] }>;
type PluginCategoryOptions = Readonly<{
    pluginCategories: readonly PluginNativeCategory[];
    resolveLabel?: (pluginId: string, label: PluginDeclarativeButtonV1['label']) => string;
}>;
// Expo's iOS setter replaces a previously read OS snapshot. All writers use
// this one owner, including declaration updates racing initial setup.
let registration: Promise<void> = Promise.resolve();
function registerInOrder(write: () => Promise<void>): Promise<void> {
    const operation = registration.then(write, write);
    registration = operation.catch(() => {});
    return operation;
}

async function registerPluginCategories(Notifications: Pick<ExpoNotificationsModule, 'setNotificationCategoryAsync'>, options: PluginCategoryOptions) {
    for (const category of options.pluginCategories) {
        await Notifications.setNotificationCategoryAsync(buildPluginNotificationCategoryId(category.pluginId, category.categoryId),
            category.buttons.map(button => ({ identifier: buildPluginNotificationButtonId(category.pluginId, category.categoryId, button.id),
                buttonTitle: options.resolveLabel?.(category.pluginId, button.label)
                    ?? (typeof button.label === 'string' ? button.label : button.label.fallback),
                options: { opensAppToForeground: true },
            }))).catch(() => { console.warn('[notifications] Plugin notification category registration unavailable'); });
    }
}

export function configurePluginNotificationCategories(Notifications: Pick<ExpoNotificationsModule, 'setNotificationCategoryAsync'>, options: PluginCategoryOptions): Promise<void> {
    return registerInOrder(() => registerPluginCategories(Notifications, options));
}

/** The category owner shared by app startup and the Guard push producer's identifiers. */
export function configureNotificationCategories(Notifications: Pick<ExpoNotificationsModule, 'setNotificationCategoryAsync'>, pluginOptions?: PluginCategoryOptions): Promise<void> {
    return registerInOrder(async () => {
        let opensAppToForeground = true;
        if (Platform.OS === 'android') {
            const registration = await syncSessionChangedBackgroundWakeTaskRegistration();
            opensAppToForeground = registration.status !== 'registered' && registration.status !== 'already_registered';
        } else if (Platform.OS === 'ios') {
            opensAppToForeground = !await initializeIOSNotificationBackgroundResponses();
        }
        // iOS permission actions require authentication; credential accessibility stays unchanged.
        const permissionOptions = { opensAppToForeground,
            ...(Platform.OS === 'ios' ? { isAuthenticationRequired: true } : {}) };
        // Expo's iOS category setter replaces an asynchronously loaded snapshot; keep this batch sequential.
        await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1, [
            { identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, buttonTitle: t('notifications.actions.allow'), options: permissionOptions },
            { identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1, buttonTitle: t('notifications.actions.deny'), options: { ...permissionOptions, isDestructive: true } },
        ]).catch(() => { console.warn('[notifications] Permission notification category registration unavailable'); });
        await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1, [
            { identifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, buttonTitle: t('notifications.actions.answer'), options: { opensAppToForeground: true } },
        ]).catch(() => { console.warn('[notifications] Answer notification category registration unavailable'); });
        const choiceActions = [PUSH_NOTIFICATION_ACTION_IDS.questionChoice1V1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1, PUSH_NOTIFICATION_ACTION_IDS.questionChoice3V1];
        const choiceCategories = [PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices1V1, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices2V1, PUSH_NOTIFICATION_CATEGORY_IDS.questionChoices3V1];
        for (const [index, category] of choiceCategories.entries()) {
            await Notifications.setNotificationCategoryAsync(category, choiceActions.slice(0, index + 1).map((identifier, choice) => ({
                identifier, buttonTitle: String(choice + 1), options: permissionOptions,
            }))).catch(() => { console.warn('[notifications] Question choice category registration unavailable'); });
        }
        await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1, [{
            identifier: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, buttonTitle: t('notifications.actions.questionReply'), options: permissionOptions,
            textInput: { submitButtonTitle: t('notifications.actions.questionReply'), placeholder: t('notifications.actions.questionPlaceholder') },
        }]).catch(() => { console.warn('[notifications] Question reply category registration unavailable'); });
        await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1, [
            { identifier: PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1, buttonTitle: t('machineGuard.session.keepRunning'), options: { opensAppToForeground: true } },
            { identifier: PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1, buttonTitle: t('common.stop'), options: { opensAppToForeground: true, isDestructive: true } },
        ]).catch(() => { console.warn('[notifications] Guard notification category registration unavailable'); });
        if (pluginOptions) await registerPluginCategories(Notifications, pluginOptions);
    });
}
