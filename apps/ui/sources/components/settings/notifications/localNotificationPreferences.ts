import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

type DeviceOverrides = LocalSettings['attentionDeviceOverridesV1'];
type LocalNotifications = DeviceOverrides['localNotifications'];
type LocalNotificationEvent = keyof LocalNotifications['events'];
export type LocalNotificationForegroundBehavior = DeviceOverrides['foregroundBehavior'];

/**
 * The notifications this device shows itself, as person-facing preferences over the nested
 * `attentionDeviceOverridesV1` record. Settings → Notifications, Personalize's "Stay in the loop"
 * step and the declared settings Actions read and write them here, so every surface keeps the
 * sibling fields of that record and the same meaning for "on".
 */
export type LocalNotificationPreferenceId =
    | 'enabled'
    | 'ready'
    | 'readyPreview'
    | 'requestPreview'
    | 'permissionRequests'
    | 'userActions';

/** Notifications on this device are off as a whole (either switch); the per-event rows then read as disabled. */
export function areLocalNotificationsOff(local: Pick<LocalSettings, 'attentionDeviceOverridesV1'>): boolean {
    const overrides = local.attentionDeviceOverridesV1;
    return overrides.enabled === false || overrides.localNotifications.enabled === false;
}

const EVENT_BY_PREFERENCE: Readonly<Partial<Record<LocalNotificationPreferenceId, LocalNotificationEvent>>> = {
    ready: 'ready',
    permissionRequests: 'permission_request',
    userActions: 'user_action_request',
};

export function readLocalNotificationPreference(
    local: Pick<LocalSettings, 'attentionDeviceOverridesV1'>,
    id: LocalNotificationPreferenceId,
): boolean {
    const notifications = local.attentionDeviceOverridesV1.localNotifications;
    if (id === 'enabled') return !areLocalNotificationsOff(local);
    if (id === 'readyPreview') return notifications.previewBehavior !== 'status_only';
    if (id === 'requestPreview') return notifications.requestPreviewBehavior !== 'status_only';
    return notifications.events[EVENT_BY_PREFERENCE[id]!] !== false;
}

/**
 * The local-settings write for one preference, keeping every sibling field. A message preview
 * that is turned on follows the Account's preview policy (`account`); off shows the status only.
 */
export function resolveLocalNotificationPreferenceDelta(
    local: Pick<LocalSettings, 'attentionDeviceOverridesV1'>,
    id: LocalNotificationPreferenceId,
    value: boolean,
): Pick<LocalSettings, 'attentionDeviceOverridesV1'> {
    const overrides = local.attentionDeviceOverridesV1;
    const notifications = overrides.localNotifications;
    const event = EVENT_BY_PREFERENCE[id];
    const nextNotifications: LocalNotifications = id === 'enabled'
        ? { ...notifications, enabled: value }
        : id === 'readyPreview'
            ? { ...notifications, previewBehavior: value ? 'account' : 'status_only' }
            : id === 'requestPreview'
                ? { ...notifications, requestPreviewBehavior: value ? 'account' : 'status_only' }
                : { ...notifications, events: { ...notifications.events, [event!]: value } };
    return { attentionDeviceOverridesV1: { ...overrides, localNotifications: nextNotifications } };
}

export function resolveLocalNotificationForegroundDelta(
    local: Pick<LocalSettings, 'attentionDeviceOverridesV1'>,
    foregroundBehavior: LocalNotificationForegroundBehavior,
): Pick<LocalSettings, 'attentionDeviceOverridesV1'> {
    return { attentionDeviceOverridesV1: { ...local.attentionDeviceOverridesV1, foregroundBehavior } };
}

/** A declared device notification row: Actions read and write it through this owner, keeping sibling fields. */
export function localNotificationStorageBinding(id: LocalNotificationPreferenceId): SettingStorageBinding {
    return {
        scope: 'local', kind: 'localOwner', access: 'read_write',
        read: local => readLocalNotificationPreference(local, id),
        parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
        commit: (local, value, writeLocal) => {
            if (typeof value === 'boolean') writeLocal(resolveLocalNotificationPreferenceDelta(local, id, value));
        },
    };
}

const FOREGROUND_BEHAVIORS = ['account', 'full', 'silent', 'off'] as const satisfies readonly LocalNotificationForegroundBehavior[];
const isForegroundBehavior = (value: unknown): value is LocalNotificationForegroundBehavior =>
    typeof value === 'string' && (FOREGROUND_BEHAVIORS as readonly string[]).includes(value);

export const localNotificationForegroundStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    allowedValues: FOREGROUND_BEHAVIORS,
    read: local => local.attentionDeviceOverridesV1.foregroundBehavior,
    parse: value => isForegroundBehavior(value) ? { success: true, value } : { success: false },
    commit: (local, value, writeLocal) => {
        if (isForegroundBehavior(value)) writeLocal(resolveLocalNotificationForegroundDelta(local, value));
    },
};
