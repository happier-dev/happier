import {
    accountSettingsParse,
    AttentionDeliveryPolicyV1Schema,
    resolveAttentionDeliveryPolicyDecision,
    type AccountSettings,
    type AttentionDeliveryPolicyV1,
} from '@happier-dev/protocol';

import {
    AttentionDeviceOverridesV1Schema,
    type AttentionDeviceOverridesV1,
} from '@/sync/domains/settings/attentionDeviceOverridesV1';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

import type {
    ActivityAttentionDeliveryChannel,
    ActivityAttentionDeliveryEventKind,
    ActivityAttentionDeliveryPlan,
    ActivityAttentionSurface,
    ActivityAttentionUpdateBudgetHint,
} from './activityAttentionDeliveryPlanTypes';
import type { ActivitySurfaceSelectionSpec } from '../selection/activitySurfaceSelectionTypes';
import { resolveDeviceQuietHoursOverride } from './resolveQuietHoursState';

type ResolveActivityAttentionDeliveryPlanParams = Readonly<{
    accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>;
    localSettings: Partial<LocalSettings> | Readonly<Record<string, unknown>>;
    event: ActivityAttentionDeliveryEventKind;
    channel: ActivityAttentionDeliveryChannel;
    now: Date;
    foregroundState?: 'foreground' | 'background';
    sameSessionVisible?: boolean;
    terminalFrontmost?: boolean;
    featureEnabled?: boolean;
    platformSupported?: boolean;
    surface?: ActivityAttentionSurface | null;
    requestedSelection?: ActivitySurfaceSelectionSpec | null;
    staleAfterMs?: number | null;
    dwellMs?: number | null;
    updateBudget?: ActivityAttentionUpdateBudgetHint | null;
}>;

function readAccountPolicy(accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>): AttentionDeliveryPolicyV1 {
    return accountSettingsParse(accountSettings).attentionDeliveryPolicyV1;
}

function clonePolicy(policy: AttentionDeliveryPolicyV1): AttentionDeliveryPolicyV1 {
    return AttentionDeliveryPolicyV1Schema.parse({
        ...policy,
        events: { ...policy.events },
        channels: Object.fromEntries(
            Object.entries(policy.channels).map(([channel, config]) => [
                channel,
                {
                    ...config,
                    events: Object.fromEntries(
                        Object.entries(config.events).map(([event, eventConfig]) => [
                            event,
                            { ...eventConfig },
                        ]),
                    ),
                },
            ]),
        ),
        quietHours: {
            ...policy.quietHours,
            windows: policy.quietHours.windows.map((window) => ({ ...window })),
        },
        privacy: {
            ...policy.privacy,
            surfaces: { ...policy.privacy.surfaces },
        },
        sounds: {
            ...policy.sounds,
            eventSoundIds: { ...policy.sounds.eventSoundIds },
        },
    });
}

function applyQuietHoursOverride(
    policy: AttentionDeliveryPolicyV1,
    overrides: AttentionDeviceOverridesV1,
): void {
    const quietHoursOverride = resolveDeviceQuietHoursOverride(overrides);
    if (quietHoursOverride.mode === 'account') return;
    if (quietHoursOverride.mode === 'disabled') {
        policy.quietHours = {
            ...policy.quietHours,
            enabled: false,
            windows: [],
        };
        return;
    }
    policy.quietHours = {
        ...policy.quietHours,
        enabled: true,
        timezone: quietHoursOverride.timezone,
        windows: quietHoursOverride.windows.map((window) => ({
            ...window,
            days: window.days ? [...window.days] : undefined,
        })),
    };
}

function setChannelEventEnabled(
    policy: AttentionDeliveryPolicyV1,
    channel: ActivityAttentionDeliveryChannel,
    event: ActivityAttentionDeliveryEventKind,
    enabled: boolean,
): void {
    const channelConfig = policy.channels[channel];
    if (!channelConfig) return;
    const currentEventConfig = channelConfig.events[event];
    channelConfig.events[event] = {
        ...currentEventConfig,
        enabled: currentEventConfig?.enabled !== false && enabled,
    };
}

function restrictChannelEnabled(
    policy: AttentionDeliveryPolicyV1,
    channel: ActivityAttentionDeliveryChannel,
    enabled: boolean,
): void {
    const channelConfig = policy.channels[channel];
    if (!channelConfig) return;
    channelConfig.enabled = channelConfig.enabled !== false && enabled;
}

function applyLocalNotificationOverrides(
    policy: AttentionDeliveryPolicyV1,
    overrides: AttentionDeviceOverridesV1,
): void {
    restrictChannelEnabled(policy, 'local_notification', overrides.localNotifications.enabled);
    setChannelEventEnabled(policy, 'local_notification', 'ready', overrides.localNotifications.events.ready);
    setChannelEventEnabled(
        policy,
        'local_notification',
        'permission_request',
        overrides.localNotifications.events.permission_request,
    );
    setChannelEventEnabled(
        policy,
        'local_notification',
        'user_action_request',
        overrides.localNotifications.events.user_action_request,
    );
    if (overrides.localNotifications.previewBehavior !== 'account') {
        policy.channels.local_notification.previewBehavior = overrides.localNotifications.previewBehavior;
    }
    if (overrides.foregroundBehavior !== 'account') {
        policy.foregroundBehavior = overrides.foregroundBehavior;
    }
}

function applySoundOverrides(policy: AttentionDeliveryPolicyV1, overrides: AttentionDeviceOverridesV1): void {
    policy.sounds = {
        ...policy.sounds,
        volume: overrides.sounds.volume,
    };
    if (overrides.sounds.enabled === false) {
        policy.channels.local_notification = {
            ...policy.channels.local_notification,
            soundId: 'none',
        };
    }
}

function applyBadgeOverrides(policy: AttentionDeliveryPolicyV1, overrides: AttentionDeviceOverridesV1): void {
    restrictChannelEnabled(policy, 'badge', overrides.badge.enabled);
    setChannelEventEnabled(policy, 'badge', 'ready', overrides.badge.includeUnread);
    setChannelEventEnabled(policy, 'badge', 'permission_request', overrides.badge.includePendingPermissionRequests);
    setChannelEventEnabled(policy, 'badge', 'user_action_request', overrides.badge.includePendingUserActionRequests);
}

function applySurfacePrivacyOverrides(policy: AttentionDeliveryPolicyV1, overrides: AttentionDeviceOverridesV1): void {
    if (overrides.liveActivities.privacyMode !== 'account') {
        policy.privacy.surfaces.live_activity = overrides.liveActivities.privacyMode;
    }
    if (overrides.widgets.privacyMode !== 'account') {
        policy.privacy.surfaces.home_widget = overrides.widgets.privacyMode;
    }
    if (overrides.privacy.previewBehavior !== 'account') {
        policy.privacy.defaultPreviewBehavior = overrides.privacy.previewBehavior;
    }
}

function readDeviceOverrides(
    localSettings: Partial<LocalSettings> | Readonly<Record<string, unknown>>,
): AttentionDeviceOverridesV1 {
    return AttentionDeviceOverridesV1Schema.parse(
        (localSettings as Readonly<Record<string, unknown>>).attentionDeviceOverridesV1,
    );
}

function buildEffectivePolicy(params: Readonly<{
    accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>;
    overrides: AttentionDeviceOverridesV1;
}>): AttentionDeliveryPolicyV1 {
    const policy = clonePolicy(readAccountPolicy(params.accountSettings));
    const overrides = params.overrides;

    if (!overrides.enabled) {
        return policy;
    }

    applyQuietHoursOverride(policy, overrides);
    applyLocalNotificationOverrides(policy, overrides);
    applySoundOverrides(policy, overrides);
    applyBadgeOverrides(policy, overrides);
    applySurfacePrivacyOverrides(policy, overrides);
    return policy;
}

export function resolveActivityAttentionDeliveryPlan(
    params: ResolveActivityAttentionDeliveryPlanParams,
): ActivityAttentionDeliveryPlan {
    const overrides = readDeviceOverrides(params.localSettings);
    const policy = buildEffectivePolicy({
        accountSettings: params.accountSettings,
        overrides,
    });
    const terminalFrontmost = overrides.enabled && overrides.terminalSmartSuppression.enabled === false
        ? false
        : params.terminalFrontmost;

    const decision = resolveAttentionDeliveryPolicyDecision({
        policy,
        event: params.event,
        channel: params.channel,
        now: params.now,
        foregroundState: params.foregroundState,
        sameSessionVisible: params.sameSessionVisible,
        terminalFrontmost,
        featureEnabled: params.featureEnabled,
        platformSupported: params.platformSupported,
    });
    return {
        ...decision,
        channelDecision: {
            channel: params.channel,
            delivery: decision.delivery,
            reason: decision.reason,
        },
        surfacePolicy: {
            surface: params.surface ?? null,
            selection: params.requestedSelection ?? null,
            privacyMode: decision.previewBehavior,
            staleAfterMs: typeof params.staleAfterMs === 'number' ? params.staleAfterMs : null,
            dwellMs: typeof params.dwellMs === 'number' ? params.dwellMs : null,
            updateBudget: params.updateBudget ?? null,
        },
    };
}
