import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';

export { readNotificationSoundPreset, resolveNotificationQuietHoursTimezone, readAccountNotificationPreference, updateAccountNotificationPreference, updateAccountNotificationPreferencesFromChannelPatch, applyNotificationChannelPreferencePatchToRawSettings, accountNotificationStorageBinding } from '@happier-dev/protocol/actions/settings/notificationPreferenceMutations';
export type { NotificationEventPreference, AccountNotificationPreference, NotificationSoundPreset } from '@happier-dev/protocol/actions/settings/notificationPreferenceMutations';

type Badge = LocalSettings['attentionDeviceOverridesV1']['badge'];
export type NotificationBadgeField = 'enabled' | 'includeUnread' | 'includePendingPermissionRequests' | 'includePendingUserActionRequests' | 'includeQueuedUserInput' | 'includeFriendRequestsInboxCount' | 'includeDesktopNonNumericDot';
export function updateNotificationBadge(local: LocalSettings, patch: Partial<Badge>): Partial<LocalSettings> {
    const overrides = local.attentionDeviceOverridesV1;
    return { attentionDeviceOverridesV1: { ...overrides, badge: { ...overrides.badge, ...patch } } };
}
export function notificationBadgeStorageBinding(field: NotificationBadgeField): SettingStorageBinding {
    return { scope: 'local', kind: 'localOwner', access: 'read_write', read: local => local.attentionDeviceOverridesV1.badge[field] !== false,
        parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
        commit: (local, value, write) => { if (typeof value === 'boolean') write(updateNotificationBadge(local, { [field]: value })); },
    };
}
export function updateNotificationDeviceSounds(local: LocalSettings, enabled: boolean): Partial<LocalSettings> {
    const overrides = local.attentionDeviceOverridesV1;
    return { attentionDeviceOverridesV1: { ...overrides, sounds: { ...overrides.sounds, enabled } } };
}
export const notificationDeviceSoundsStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', read: local => local.attentionDeviceOverridesV1.sounds.enabled !== false,
    parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
    commit: (local, value, write) => { if (typeof value === 'boolean') write(updateNotificationDeviceSounds(local, value)); },
};
export function updateNotificationDeviceQuietHours(local: LocalSettings, quietHoursOverride: LocalSettings['attentionDeviceOverridesV1']['quietHoursOverride']): Partial<LocalSettings> {
    return { attentionDeviceOverridesV1: { ...local.attentionDeviceOverridesV1, quietHoursOverride } };
}
const quietHoursSchema = AttentionDeviceOverridesV1Schema.removeCatch().shape.quietHoursOverride.removeDefault();
export const notificationDeviceQuietHoursStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', read: local => local.attentionDeviceOverridesV1.quietHoursOverride,
    parse: value => { const parsed = quietHoursSchema.safeParse(value); if (!parsed.success) return { success: false };
        const json = SettingsDeclarationValueV1Schema.safeParse(parsed.data); return json.success ? { success: true, value: json.data } : { success: false }; },
    commit: (local, value, write) => { const parsed = quietHoursSchema.safeParse(value); if (parsed.success) write(updateNotificationDeviceQuietHours(local, parsed.data)); },
};
