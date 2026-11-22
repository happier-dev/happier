import { NOTIFICATION_QUESTION_CHOICES, PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol';
import { t } from '@/text';
import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { notificationPermissionActionsOpenApp } from './notificationBackgroundTaskState';

export async function configureNotificationCategories(
    Notifications: Pick<ExpoNotificationsModule, 'setNotificationCategoryAsync'>,
    platform: string,
): Promise<void> {
    if (platform === 'web') return;
    const opensAppToForeground = await notificationPermissionActionsOpenApp(platform);
    // Saved credentials retain their existing WHEN_UNLOCKED protection.
    const permissionOptions = {
        opensAppToForeground,
        ...(platform === 'ios' ? { isAuthenticationRequired: true } : {}),
    };

    // Expo docs recommend avoiding ':' and '-' in category identifiers.
    // Our category ids live in `@happier-dev/protocol` so the CLI push payload and app registration stay in sync.
    // Expo's iOS setters read and replace the entire category set. Register
    // categories in sequence so concurrent initial reads cannot lose a sibling.
    await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1, [
        {
            identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            buttonTitle: t('notifications.actions.allow'),
            options: permissionOptions,
        },
        {
            identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1,
            buttonTitle: t('notifications.actions.deny'),
            options: { ...permissionOptions, isDestructive: true },
        },
    ]).catch(() => { console.warn('[notifications] Permission notification category registration unavailable'); });
    await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1, [
        {
            identifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1,
            buttonTitle: t('notifications.actions.answer'),
            options: { opensAppToForeground: true },
        },
    ]).catch(() => { console.warn('[notifications] Answer notification category registration unavailable'); });
    for (const [index, { categoryId }] of NOTIFICATION_QUESTION_CHOICES.entries()) {
        await Notifications.setNotificationCategoryAsync(categoryId, NOTIFICATION_QUESTION_CHOICES.slice(0, index + 1).map(({ actionId }, choice) => ({
            identifier: actionId, buttonTitle: String(choice + 1), options: permissionOptions,
        }))).catch(() => { console.warn('[notifications] Question choice category registration unavailable'); });
    }
    await Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.questionTextV1, [{
        identifier: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1,
        buttonTitle: t('notifications.actions.questionReply'),
        options: permissionOptions,
        textInput: { submitButtonTitle: t('notifications.actions.questionReply'), placeholder: t('notifications.actions.questionPlaceholder') },
    }]).catch(() => { console.warn('[notifications] Question reply category registration unavailable'); });
}
