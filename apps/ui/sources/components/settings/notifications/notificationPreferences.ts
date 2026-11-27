import * as z from 'zod/mini';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { AttentionQuietHoursInputSchema } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { resolveInAppNotificationSounds } from '@/activity/notifications/sounds/notificationCue';
import { isDesktopHost } from '@/utils/platform/desktopHost';

export { readNotificationSoundPreset, resolveNotificationQuietHoursTimezone, readAccountNotificationPreference, updateAccountNotificationPreference, updateAccountNotificationEventSound, updateAccountNotificationPreferencesFromChannelPatch, applyNotificationChannelPreferencePatchToRawSettings, accountNotificationEventSoundStorageBinding, accountNotificationStorageBinding } from '@happier-dev/protocol/actions/settings/notificationPreferenceMutations';
export type { NotificationEventPreference, AccountNotificationPreference, NotificationSoundEvent, NotificationSoundPreset } from '@happier-dev/protocol/actions/settings/notificationPreferenceMutations';

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
type DeviceSounds = LocalSettings['attentionDeviceOverridesV1']['sounds'];
function patchNotificationDeviceSounds(local: LocalSettings, patch: Partial<DeviceSounds>): Partial<LocalSettings> {
    const overrides = local.attentionDeviceOverridesV1;
    return { attentionDeviceOverridesV1: { ...overrides, sounds: { ...overrides.sounds, ...patch } } };
}
export function updateNotificationDeviceSounds(local: LocalSettings, enabled: boolean): Partial<LocalSettings> {
    return patchNotificationDeviceSounds(local, { enabled });
}
export const notificationDeviceSoundsStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', read: local => local.attentionDeviceOverridesV1.sounds.enabled !== false,
    parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
    commit: (local, value, write) => { if (typeof value === 'boolean') write(updateNotificationDeviceSounds(local, value)); },
};
export const notificationInAppSoundStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: local => resolveInAppNotificationSounds(local.attentionDeviceOverridesV1.sounds.inApp, isDesktopHost()),
    parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
    commit: (local, value, write) => { if (typeof value === 'boolean') write(patchNotificationDeviceSounds(local, { inApp: value })); },
};
export const notificationSoundVolumeStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: local => local.attentionDeviceOverridesV1.sounds.volume ?? 1,
    parse: value => typeof value === 'number' && value >= 0 && value <= 1 ? { success: true, value } : { success: false },
    commit: (local, value, write) => { if (typeof value === 'number') write(patchNotificationDeviceSounds(local, { volume: value })); },
};
export function updateNotificationDeviceQuietHours(local: LocalSettings, quietHoursOverride: LocalSettings['attentionDeviceOverridesV1']['quietHoursOverride']): Partial<LocalSettings> {
    return { attentionDeviceOverridesV1: { ...local.attentionDeviceOverridesV1, quietHoursOverride } };
}
// Authoring is closed; persisted device reads keep their separate historical tolerance.
const quietHoursSchema = z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('account') }),
    z.strictObject({ mode: z.literal('disabled') }),
    z.strictObject({ mode: z.literal('custom'), timezone: AttentionQuietHoursInputSchema.shape.timezone,
        windows: AttentionQuietHoursInputSchema.shape.windows }),
]);
export const notificationDeviceQuietHoursStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', read: local => local.attentionDeviceOverridesV1.quietHoursOverride,
    parse: value => { const parsed = quietHoursSchema.safeParse(value); if (!parsed.success) return { success: false };
        const json = SettingsDeclarationValueV1Schema.safeParse(parsed.data); return json.success ? { success: true, value: json.data } : { success: false }; },
    commit: (local, value, write) => { const parsed = quietHoursSchema.safeParse(value); if (parsed.success) write(updateNotificationDeviceQuietHours(local, parsed.data)); },
};
