import { accountSettingsParse, resolveAttentionDeliveryPolicyDecision, type AccountSettings, type AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { composeAttentionDeliveryPolicyDeviceOverrides } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';

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
import type { ActivitySurfacePrivacyMode } from '../attention/resolveActivitySurfacePolicy';
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

// Badge and delivery selectors resolve the policy on every store change, and a
// full Account settings parse dominated those passes. Settings objects are
// replaced, never mutated, so the parsed policy is cached by object identity;
// callers receive their own copy because policy composition mutates its result.
const accountPolicyBySettings = new WeakMap<object, AttentionDeliveryPolicyV1>();

function readAccountPolicy(accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>): AttentionDeliveryPolicyV1 {
    let policy = accountPolicyBySettings.get(accountSettings);
    if (!policy) {
        policy = accountSettingsParse(accountSettings).attentionDeliveryPolicyV1;
        accountPolicyBySettings.set(accountSettings, policy);
    }
    return structuredClone(policy);
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
    for (const event of ['ready', 'permission_request', 'user_action_request'] as const) {
        const previewBehavior = event === 'ready'
            ? overrides.localNotifications.previewBehavior
            : overrides.localNotifications.requestPreviewBehavior;
        if (previewBehavior !== 'account') {
            policy.channels.local_notification.events[event] = {
                ...policy.channels.local_notification.events[event],
                previewBehavior,
            };
        }
    }
}

function applySoundOverrides(policy: AttentionDeliveryPolicyV1, overrides: AttentionDeviceOverridesV1): void {
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

const ACTIVITY_SURFACE_PRIVACY_RANK: Readonly<Record<ActivitySurfacePrivacyMode, number>> = {
    status_only: 0,
    title_only: 1,
    include_preview: 2,
};

/**
 * Return the stricter of two presentation modes. Account and device privacy are
 * independent ceilings: either may withhold more, but neither may widen the
 * other.
 */
export function resolveStricterActivitySurfacePrivacyMode(
    left: ActivitySurfacePrivacyMode,
    right: ActivitySurfacePrivacyMode,
): ActivitySurfacePrivacyMode {
    return ACTIVITY_SURFACE_PRIVACY_RANK[left] <= ACTIVITY_SURFACE_PRIVACY_RANK[right] ? left : right;
}

function applySurfacePrivacyOverrides(policy: AttentionDeliveryPolicyV1, overrides: AttentionDeviceOverridesV1): void {
    if (overrides.liveActivities.privacyMode !== 'account') {
        policy.privacy.surfaces.live_activity = resolveStricterActivitySurfacePrivacyMode(
            policy.privacy.surfaces.live_activity ?? policy.privacy.defaultPreviewBehavior,
            overrides.liveActivities.privacyMode,
        );
    }
    if (overrides.widgets.privacyMode !== 'account') {
        policy.privacy.surfaces.home_widget = resolveStricterActivitySurfacePrivacyMode(
            policy.privacy.surfaces.home_widget ?? policy.privacy.defaultPreviewBehavior,
            overrides.widgets.privacyMode,
        );
    }
}

function applyDefaultPrivacyOverride(
    policy: AttentionDeliveryPolicyV1,
    accountPolicy: AttentionDeliveryPolicyV1,
    overrides: AttentionDeviceOverridesV1,
): void {
    if (overrides.privacy.previewBehavior === 'account') return;
    policy.privacy.defaultPreviewBehavior = resolveStricterActivitySurfacePrivacyMode(
        accountPolicy.privacy.defaultPreviewBehavior,
        overrides.privacy.previewBehavior,
    );
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
    const accountPolicy = readAccountPolicy(params.accountSettings);
    const overrides = params.overrides;

    if (!overrides.enabled) {
        return accountPolicy;
    }

    const policy = composeAttentionDeliveryPolicyDeviceOverrides(accountPolicy, {
        quietHoursOverride: resolveDeviceQuietHoursOverride(overrides),
        foregroundBehavior: overrides.foregroundBehavior,
        previewBehavior: 'account',
        soundVolume: overrides.sounds.volume,
    });
    applyDefaultPrivacyOverride(policy, accountPolicy, overrides);
    applyLocalNotificationOverrides(policy, overrides);
    applySoundOverrides(policy, overrides);
    applyBadgeOverrides(policy, overrides);
    applySurfacePrivacyOverrides(policy, overrides);
    return policy;
}

/**
 * The notification policy in effect on this device: the Account's policy with this device's
 * overrides applied. Delivery decisions and settings summaries read the same answer.
 */
export function resolveEffectiveAttentionDeliveryPolicy(params: Readonly<{
    accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>;
    localSettings: Partial<LocalSettings> | Readonly<Record<string, unknown>>;
}>): AttentionDeliveryPolicyV1 {
    return buildEffectivePolicy({
        accountSettings: params.accountSettings,
        overrides: readDeviceOverrides(params.localSettings),
    });
}

function resolveActivitySurface(
    surface: ActivityAttentionSurface | null | undefined,
    channel: ActivityAttentionDeliveryChannel,
): ActivityAttentionSurface | null {
    if (surface) return surface;
    if (channel === 'desktop_overlay' || channel === 'live_activity' || channel === 'home_widget') {
        return channel;
    }
    return null;
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
    const privacySurface = resolveActivitySurface(params.surface, params.channel);
    const previewBehavior = privacySurface
        ? resolveStricterActivitySurfacePrivacyMode(
            decision.previewBehavior,
            policy.privacy.surfaces[privacySurface] ?? policy.privacy.defaultPreviewBehavior,
        )
        : decision.previewBehavior;
    return {
        ...decision,
        previewBehavior,
        channelDecision: {
            channel: params.channel,
            delivery: decision.delivery,
            reason: decision.reason,
        },
        surfacePolicy: {
            surface: params.surface ?? null,
            selection: params.requestedSelection ?? null,
            privacyMode: previewBehavior,
            staleAfterMs: typeof params.staleAfterMs === 'number' ? params.staleAfterMs : null,
            dwellMs: typeof params.dwellMs === 'number' ? params.dwellMs : null,
            updateBudget: params.updateBudget ?? null,
        },
    };
}
