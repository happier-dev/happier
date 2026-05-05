import * as React from 'react';

import { Platform } from 'react-native';

import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { useFriendRequests, useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityBadgeStateFromOverview } from './buildActivityBadgeState';
import { applyExpoNativeBadgeState } from './channels/applyExpoNativeBadgeState';
import { applyTauriBadgeState } from './channels/applyTauriBadgeState';

export function ActivityBadgeRuntime(): React.ReactElement | null {
    const activitySource = useActivityAttentionSource();
    const friendRequests = useFriendRequests();
    const localSettings = useLocalSettings();
    const accountSettings = useSettings();
    const { updateAvailable } = useUpdates();
    const { hasUnread: changelogHasUnread } = useChangelog();
    const parsedLocalSettings = React.useMemo(() => localSettingsParse(localSettings), [localSettings]);

    const badgeState = React.useMemo(() => {
        const now = new Date();
        const readyPlan = resolveActivityAttentionDeliveryPlan({
            accountSettings,
            localSettings: parsedLocalSettings,
            event: 'ready',
            channel: 'badge',
            now,
        });
        const permissionPlan = resolveActivityAttentionDeliveryPlan({
            accountSettings,
            localSettings: parsedLocalSettings,
            event: 'permission_request',
            channel: 'badge',
            now,
        });
        const userActionPlan = resolveActivityAttentionDeliveryPlan({
            accountSettings,
            localSettings: parsedLocalSettings,
            event: 'user_action_request',
            channel: 'badge',
            now,
        });
        if (
            readyPlan.reason === 'channel_disabled'
            && permissionPlan.reason === 'channel_disabled'
            && userActionPlan.reason === 'channel_disabled'
        ) {
            return { count: 0, showNonNumericDot: false };
        }
        const deviceOverrides = AttentionDeviceOverridesV1Schema.parse(parsedLocalSettings.attentionDeviceOverridesV1);

        const sessionOptions = {
            showUnread: readyPlan.badgeBehavior.include,
            showPendingPermissionRequests: permissionPlan.badgeBehavior.include,
            showPendingUserActionRequests: userActionPlan.badgeBehavior.include,
            showQueuedUserInput: deviceOverrides.badge.includeQueuedUserInput,
        };
        const overview = buildActivityOverviewFromSource({
            source: activitySource,
            nowMs: now.getTime(),
            sessionOptions,
        });

        return buildActivityBadgeStateFromOverview({
            overview,
            numericInboxCount:
                !deviceOverrides.badge.includeFriendRequestsInboxCount
                    ? 0
                    : friendRequests.length,
            hasNonNumericInboxAttention:
                deviceOverrides.badge.includeDesktopNonNumericDot &&
                (updateAvailable || changelogHasUnread),
            sessionOptions,
        });
    }, [
        accountSettings,
        activitySource,
        changelogHasUnread,
        friendRequests.length,
        parsedLocalSettings,
        updateAvailable,
    ]);

    React.useEffect(() => {
        if (isTauriDesktop()) {
            fireAndForget(applyTauriBadgeState(badgeState), {
                tag: 'ActivityBadgeRuntime.applyTauriBadgeState',
            });
            return;
        }

        if (Platform.OS === 'web') return;

        fireAndForget(applyExpoNativeBadgeState(badgeState), {
            tag: 'ActivityBadgeRuntime.applyExpoNativeBadgeState',
        });
    }, [badgeState]);

    return null;
}
