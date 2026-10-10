import { accountSettingsParse, AttentionDeliveryPolicyV1Schema, resolveAttentionDeliveryPolicyDecision, type AttentionDeliveryPolicyV1 } from '../../account/settings/accountSettings.js';
import { PUSH_NOTIFICATION_SOUND_IDS } from '../../push/pushNotificationActions.js';
import type { NotificationChannelConfigurationPatch } from '../notificationConfigurationActionFamily.js';
import type { NotificationChannelRecordV1 } from '../../account/settings/notificationChannelRecordV1.js';
import type { SettingDomainValueV1 } from './settingsOwnerActions.js';
import type { PortableAccountSettingBindingV1 } from './accountSettingBindings.js';

/** The one nightly schedule the settings presets offer, on the Account and on a device. */
export const NIGHTLY_QUIET_HOURS_WINDOW = Object.freeze({
    startLocalTime: '22:00',
    endLocalTime: '07:00',
});

type QuietHoursWindow = Readonly<{
    startLocalTime: string;
    endLocalTime: string;
    days?: readonly string[];
}>;

/**
 * Whether a configured schedule IS the nightly preset — not merely whether it contains it, and not
 * merely whether some override exists. A presenter that answers this loosely labels a foreign
 * schedule (an extra window, weekday-scoped hours, a schedule another device wrote) as the preset,
 * and pressing that row then silently replaces the real schedule with 22:00–07:00.
 */
export function isNightlyQuietHoursWindowSet(windows: readonly QuietHoursWindow[]): boolean {
    if (windows.length !== 1) return false;
    const [window] = windows;
    return window.startLocalTime === NIGHTLY_QUIET_HOURS_WINDOW.startLocalTime
        && window.endLocalTime === NIGHTLY_QUIET_HOURS_WINDOW.endLocalTime
        && (window.days === undefined || window.days.length === 0);
}

export type NotificationEventPreference = 'ready' | 'permission_request' | 'user_action_request' | 'follow_update'
    | 'connected_service_account_switch' | 'connected_service_quota_blocked' | 'connected_service_quota_recovered';
export type AccountNotificationPreference = NotificationEventPreference | 'pushEnabled' | 'mutePhoneWhenComputerFocused' | 'readyPreview' | 'requestPreview' | 'soundPreset' | 'quietHours';
export type NotificationSoundPreset = 'happier' | 'system' | 'silent';
const NOTIFICATION_TOPIC_PREFERENCES = [
    ['ready', 'ready'], ['permissionRequest', 'permission_request'], ['userActionRequest', 'user_action_request'],
    ['connectedServiceAccountSwitch', 'connected_service_account_switch'],
    ['connectedServiceQuotaBlocked', 'connected_service_quota_blocked'],
    ['connectedServiceQuotaRecovered', 'connected_service_quota_recovered'],
] as const;

export function readNotificationSoundPreset(policy: AttentionDeliveryPolicyV1): NotificationSoundPreset | 'custom' {
    const sounds = policy.sounds;
    const id = sounds.defaultSoundId;
    return id === PUSH_NOTIFICATION_SOUND_IDS.soft
        && (sounds.eventSoundIds.permission_request ?? PUSH_NOTIFICATION_SOUND_IDS.urgent) === PUSH_NOTIFICATION_SOUND_IDS.urgent
        && (sounds.eventSoundIds.user_action_request ?? PUSH_NOTIFICATION_SOUND_IDS.urgent) === PUSH_NOTIFICATION_SOUND_IDS.urgent
        ? 'happier' : id === PUSH_NOTIFICATION_SOUND_IDS.systemDefault ? 'system' : id === PUSH_NOTIFICATION_SOUND_IDS.none ? 'silent' : 'custom';
}

export function resolveNotificationQuietHoursTimezone(policy: AttentionDeliveryPolicyV1): string {
    const configured = policy.quietHours.timezone.trim();
    if (configured && configured !== 'UTC') return configured;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || configured || 'UTC'; }
    catch { return configured || 'UTC'; }
}

export function readAccountNotificationPreference(policy: AttentionDeliveryPolicyV1, id: AccountNotificationPreference,
    builtin?: Extract<NotificationChannelRecordV1, { kind: 'expo_push' }> | null): string | boolean {
    const push = policy.channels.expo_push;
    if (id === 'pushEnabled') return push.enabled !== false && (builtin === undefined || builtin?.enabled === true);
    if (id === 'mutePhoneWhenComputerFocused') return policy.mutePhoneWhenComputerFocused === true;
    if (id === 'readyPreview') return push.previewBehavior !== 'status_only' && (builtin === undefined || builtin?.readyIncludeMessageText === true);
    if (id === 'requestPreview') return (builtin === undefined || builtin?.requestIncludeMessageText === true) && ['permission_request', 'user_action_request'].every(event =>
        resolveAttentionDeliveryPolicyDecision({ policy, event, channel: 'expo_push', now: new Date(0) }).previewBehavior === 'include_preview');
    if (id === 'soundPreset') return readNotificationSoundPreset(policy);
    if (id === 'quietHours') return !policy.quietHours.enabled ? 'off' : isNightlyQuietHoursWindowSet(policy.quietHours.windows) ? 'nightly' : 'custom';
    const topic = NOTIFICATION_TOPIC_PREFERENCES.find(([, event]) => event === id)?.[0];
    return push.events[id].enabled !== false && policy.events[id].enabled !== false
        && (builtin === undefined || topic === undefined || builtin?.topics[topic] === true);
}

/** Screen intents and declaration CAS rebases apply the same coupled policy edit. */
export function updateAccountNotificationPreference(policy: AttentionDeliveryPolicyV1, id: AccountNotificationPreference, value: SettingDomainValueV1): AttentionDeliveryPolicyV1 {
    const push = policy.channels.expo_push;
    if (id === 'mutePhoneWhenComputerFocused') return AttentionDeliveryPolicyV1Schema.parse({ ...policy, mutePhoneWhenComputerFocused: value });
    if (id === 'quietHours') return AttentionDeliveryPolicyV1Schema.parse({ ...policy, quietHours: {
        enabled: value === 'nightly', timezone: resolveNotificationQuietHoursTimezone(policy), windows: value === 'nightly' ? [{ ...NIGHTLY_QUIET_HOURS_WINDOW }] : [],
    } });
    if (id === 'soundPreset') {
        const eventSoundIds = { ...policy.sounds.eventSoundIds };
        delete eventSoundIds.permission_request;
        delete eventSoundIds.user_action_request;
        return AttentionDeliveryPolicyV1Schema.parse({ ...policy, sounds: { ...policy.sounds,
            defaultSoundId: value === 'happier' ? PUSH_NOTIFICATION_SOUND_IDS.soft : value === 'system' ? PUSH_NOTIFICATION_SOUND_IDS.systemDefault : PUSH_NOTIFICATION_SOUND_IDS.none,
            eventSoundIds: value === 'happier' ? { ...eventSoundIds, permission_request: PUSH_NOTIFICATION_SOUND_IDS.urgent, user_action_request: PUSH_NOTIFICATION_SOUND_IDS.urgent } : eventSoundIds,
        } });
    }
    const previewBehavior = value ? 'include_preview' : 'status_only';
    const nextPush = id === 'pushEnabled' ? { ...push, enabled: value }
        : id === 'readyPreview' ? { ...push, previewBehavior }
        : id === 'requestPreview' ? { ...push, events: { ...push.events,
            permission_request: { ...push.events.permission_request, previewBehavior },
            user_action_request: { ...push.events.user_action_request, previewBehavior },
        } }
        : { ...push, events: { ...push.events, [id]: { ...push.events[id], enabled: value } } };
    return AttentionDeliveryPolicyV1Schema.parse({ ...policy, channels: { ...policy.channels, expo_push: nextPush },
        ...(['ready', 'permission_request', 'user_action_request', 'follow_update', 'connected_service_account_switch',
            'connected_service_quota_blocked', 'connected_service_quota_recovered'].includes(id)
            ? { events: { ...policy.events, [id]: { ...policy.events[id], enabled: value } } } : {}),
    });
}

/** Only supplied endpoint controls edit their corresponding finite attention fields. */
export function updateAccountNotificationPreferencesFromChannelPatch(policy: AttentionDeliveryPolicyV1,
    patch: NotificationChannelConfigurationPatch): AttentionDeliveryPolicyV1 {
    let next = policy;
    if (patch.enabled !== undefined) next = updateAccountNotificationPreference(next, 'pushEnabled', patch.enabled);
    for (const [topic, event] of NOTIFICATION_TOPIC_PREFERENCES) {
        const value = patch.topics?.[topic];
        if (value !== undefined) next = updateAccountNotificationPreference(next, event, value);
    }
    if (patch.readyIncludeMessageText !== undefined) next = updateAccountNotificationPreference(next, 'readyPreview', patch.readyIncludeMessageText);
    if (patch.requestIncludeMessageText !== undefined) next = updateAccountNotificationPreference(next, 'requestPreview', patch.requestIncludeMessageText);
    return next;
}

function rawObject(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}
/** The paired writer changes only addressed raw leaves, never serializes effective defaults. */
export function applyNotificationChannelPreferencePatchToRawSettings(raw: Readonly<Record<string, unknown>>,
    patch: NotificationChannelConfigurationPatch): Record<string, unknown> {
    const edited = updateAccountNotificationPreferencesFromChannelPatch(accountSettingsParse(raw).attentionDeliveryPolicyV1, patch);
    const policy = rawObject(raw.attentionDeliveryPolicyV1);
    const channels = rawObject(policy.channels);
    const push = rawObject(channels.expo_push);
    const events = rawObject(policy.events);
    const pushEvents = rawObject(push.events);
    if (patch.enabled !== undefined) push.enabled = edited.channels.expo_push.enabled;
    if (patch.readyIncludeMessageText !== undefined) push.previewBehavior = edited.channels.expo_push.previewBehavior;
    for (const [topic, event] of NOTIFICATION_TOPIC_PREFERENCES) {
        if (patch.topics?.[topic] === undefined) continue;
        events[event] = { ...rawObject(events[event]), enabled: edited.events[event].enabled };
        pushEvents[event] = { ...rawObject(pushEvents[event]), enabled: edited.channels.expo_push.events[event].enabled };
    }
    if (patch.requestIncludeMessageText !== undefined) for (const event of ['permission_request', 'user_action_request'] as const) {
        pushEvents[event] = { ...rawObject(pushEvents[event]), previewBehavior: edited.channels.expo_push.events[event].previewBehavior };
    }
    if (patch.topics !== undefined) policy.events = events;
    if (patch.topics !== undefined || patch.requestIncludeMessageText !== undefined) push.events = pushEvents;
    channels.expo_push = push;
    policy.channels = channels;
    return { ...raw, attentionDeliveryPolicyV1: policy };
}

export function accountNotificationStorageBinding(id: AccountNotificationPreference): PortableAccountSettingBindingV1 {
    const choices = id === 'soundPreset' ? ['happier', 'system', 'silent'] : id === 'quietHours' ? ['off', 'nightly'] : undefined;
    return { scope: 'account', kind: 'owner', access: id === 'pushEnabled' ? 'read_only' : 'read_write',
        ...(choices ? { allowedValues: choices } : {}),
        read: settings => readAccountNotificationPreference(settings.attentionDeliveryPolicyV1, id),
        parse: value => {
            if (choices) return typeof value === 'string' && choices.includes(value)
                ? { success: true, value } : { success: false };
            return typeof value === 'boolean' ? { success: true, value } : { success: false };
        },
        mutate: (settings, value) => ({ attentionDeliveryPolicyV1: updateAccountNotificationPreference(settings.attentionDeliveryPolicyV1, id, value) }),
    };
}
