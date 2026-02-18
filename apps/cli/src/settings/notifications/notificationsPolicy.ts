import { DEFAULT_NOTIFICATIONS_SETTINGS_V1, type AccountSettings } from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

function resolveNotifications(settings: AccountSettings | null | undefined): AccountSettings['notificationsSettingsV1'] {
  return settings?.notificationsSettingsV1 ?? DEFAULT_NOTIFICATIONS_SETTINGS_V1;
}

export function shouldSendReadyPushNotification(settings?: AccountSettings | null): boolean {
  const notifications = resolveNotifications(settings);
  return notifications.pushEnabled !== false && notifications.ready !== false;
}

export function shouldSendPermissionRequestPushNotification(settings?: AccountSettings | null): boolean {
  const notifications = resolveNotifications(settings);
  return notifications.pushEnabled !== false && notifications.permissionRequest !== false;
}

export function shouldSendReadyPushNotificationForActiveAccount(): boolean {
  return shouldSendReadyPushNotification(getActiveAccountSettingsSnapshot()?.settings ?? null);
}

export function shouldSendPermissionRequestPushNotificationForActiveAccount(): boolean {
  return shouldSendPermissionRequestPushNotification(getActiveAccountSettingsSnapshot()?.settings ?? null);
}
