import {
    type AccountSettings,
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    NotificationsSettingsV1Schema,
} from '@happier-dev/protocol';

import type { LocalSettings } from '@/sync/domains/settings/localSettings';

export type ForegroundNotificationBehavior = 'full' | 'silent' | 'off';

export function resolveForegroundNotificationBehavior(params: Readonly<{
    localSettings: Partial<LocalSettings> | null | undefined;
    accountSettings: Partial<AccountSettings> | null | undefined;
}>): ForegroundNotificationBehavior {
    if (params.localSettings?.localNotificationsEnabled === false) {
        return 'off';
    }

    const localForegroundBehavior = params.localSettings?.localNotificationsForegroundBehavior;
    if (
        localForegroundBehavior === 'full' ||
        localForegroundBehavior === 'silent' ||
        localForegroundBehavior === 'off'
    ) {
        return localForegroundBehavior;
    }

    const notificationsSettingsInput = params.accountSettings?.notificationsSettingsV1 ?? DEFAULT_NOTIFICATIONS_SETTINGS_V1;
    const notificationsSettingsResult = NotificationsSettingsV1Schema.safeParse(notificationsSettingsInput);
    const notificationsSettings = notificationsSettingsResult.success
        ? notificationsSettingsResult.data
        : DEFAULT_NOTIFICATIONS_SETTINGS_V1;

    return notificationsSettings.foregroundBehavior ?? 'full';
}
