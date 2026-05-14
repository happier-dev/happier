import * as React from 'react';

import { Platform } from 'react-native';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { useFriendRequests, useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityBadgeStateFromOverview } from './buildActivityBadgeState';
import { applyExpoNativeBadgeState } from './channels/applyExpoNativeBadgeState';
import { applyTauriBadgeState } from './channels/applyTauriBadgeState';

type ServerBadgeSnapshot = Readonly<{
    count: number;
    serverGeneration: number;
    serverId: string;
}>;

type ActivityBadgeSessionOptions = Readonly<{
    showUnread: boolean;
    showPendingPermissionRequests: boolean;
    showPendingUserActionRequests: boolean;
}>;

async function fetchServerBadgeCount(): Promise<number | null> {
    try {
        const response = await serverFetch('/v1/account/activity/badge-snapshot', {
            method: 'GET',
        }, { retry: 'none' });
        if (!response.ok) return null;
        const json = await response.json();
        const badgeCount = (json as { badgeCount?: unknown } | null | undefined)?.badgeCount;
        return typeof badgeCount === 'number' && Number.isInteger(badgeCount) && badgeCount >= 0 ? badgeCount : null;
    } catch {
        return null;
    }
}

function canUseServerBadgeSnapshot(options: ActivityBadgeSessionOptions): boolean {
    return options.showUnread
        && options.showPendingPermissionRequests
        && options.showPendingUserActionRequests;
}

export function ActivityBadgeRuntime(): React.ReactElement | null {
    const activitySource = useActivityAttentionSource();
    const friendRequests = useFriendRequests();
    const localSettings = useLocalSettings();
    const accountSettings = useSettings();
    const activeServer = useActiveServerSnapshot();
    const { updateAvailable } = useUpdates();
    const { hasUnread: changelogHasUnread } = useChangelog();
    const parsedLocalSettings = React.useMemo(() => localSettingsParse(localSettings), [localSettings]);
    const isTauriDesktopHost = isTauriDesktop();
    const shouldApplyBadgeRuntime = isTauriDesktopHost || Platform.OS !== 'web';
    const [serverBadgeSnapshot, setServerBadgeSnapshot] = React.useState<ServerBadgeSnapshot | null>(null);

    const badgeModel = React.useMemo(() => {
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
        const channelDisabled =
            readyPlan.reason === 'channel_disabled'
            && permissionPlan.reason === 'channel_disabled'
            && userActionPlan.reason === 'channel_disabled';
        if (channelDisabled) {
            return {
                channelDisabled,
                sessionOptions: {
                    showUnread: false,
                    showPendingPermissionRequests: false,
                    showPendingUserActionRequests: false,
                },
                localBadgeState: { count: 0, showNonNumericDot: false },
            };
        }
        const deviceOverrides = AttentionDeviceOverridesV1Schema.parse(parsedLocalSettings.attentionDeviceOverridesV1);

        const sessionOptions = {
            showUnread: readyPlan.badgeBehavior.include,
            showPendingPermissionRequests: permissionPlan.badgeBehavior.include,
            showPendingUserActionRequests: userActionPlan.badgeBehavior.include,
        };
        const overview = buildActivityOverviewFromSource({
            source: activitySource,
            nowMs: now.getTime(),
            sessionOptions,
            includeWarmSourceWhenNotReady: true,
        });

        return {
            channelDisabled,
            sessionOptions,
            localBadgeState: buildActivityBadgeStateFromOverview({
                overview,
                numericInboxCount:
                    !deviceOverrides.badge.includeFriendRequestsInboxCount
                        ? 0
                        : friendRequests.length,
                hasNonNumericInboxAttention:
                    deviceOverrides.badge.includeDesktopNonNumericDot &&
                    (updateAvailable || changelogHasUnread),
                sessionOptions,
            }),
        };
    }, [
        accountSettings,
        activitySource,
        changelogHasUnread,
        friendRequests.length,
        parsedLocalSettings,
        updateAvailable,
    ]);

    const serverSnapshotAllowed = !badgeModel.channelDisabled && canUseServerBadgeSnapshot(badgeModel.sessionOptions);
    const hasLocalActivitySource =
        Object.keys(activitySource.sessionsById).length > 0
        || Object.keys(activitySource.sessionListRenderablesById).length > 0
        || Object.values(activitySource.sessionListIndexByServerId).some((items) => Array.isArray(items) && items.length > 0)
        || Object.values(activitySource.concurrentSessionListCacheByServerId).some((entry) => {
            return entry && typeof entry === 'object' && Object.keys(entry.sessions ?? {}).length > 0;
        });

    React.useEffect(() => {
        if (!shouldApplyBadgeRuntime || !serverSnapshotAllowed || !activeServer.serverId || !activeServer.serverUrl) {
            setServerBadgeSnapshot(null);
            return;
        }

        let cancelled = false;
        setServerBadgeSnapshot(null);
        void fetchServerBadgeCount().then((count) => {
            if (cancelled || count === null) return;
            setServerBadgeSnapshot({
                count,
                serverGeneration: activeServer.generation,
                serverId: activeServer.serverId,
            });
        });

        return () => {
            cancelled = true;
        };
    }, [
        activeServer.generation,
        activeServer.serverId,
        activeServer.serverUrl,
        serverSnapshotAllowed,
        shouldApplyBadgeRuntime,
    ]);

    const badgeState = React.useMemo(() => {
        if (badgeModel.channelDisabled) return badgeModel.localBadgeState;
        if (activitySource.isDataReady || hasLocalActivitySource) return badgeModel.localBadgeState;
        if (
            serverSnapshotAllowed
            && serverBadgeSnapshot
            && serverBadgeSnapshot.serverGeneration === activeServer.generation
            && serverBadgeSnapshot.serverId === activeServer.serverId
        ) {
            return { count: serverBadgeSnapshot.count, showNonNumericDot: false };
        }
        return null;
    }, [
        activeServer.generation,
        activeServer.serverId,
        activitySource.isDataReady,
        badgeModel,
        hasLocalActivitySource,
        serverBadgeSnapshot,
        serverSnapshotAllowed,
    ]);

    const badgeCount = badgeState?.count;
    const showNonNumericDot = badgeState?.showNonNumericDot;

    React.useEffect(() => {
        if (badgeCount === undefined || showNonNumericDot === undefined) return;
        const nextBadgeState = {
            count: badgeCount,
            showNonNumericDot,
        };
        if (isTauriDesktopHost) {
            fireAndForget(applyTauriBadgeState(nextBadgeState), {
                tag: 'ActivityBadgeRuntime.applyTauriBadgeState',
            });
            return;
        }

        if (Platform.OS === 'web') return;

        fireAndForget(applyExpoNativeBadgeState(nextBadgeState), {
            tag: 'ActivityBadgeRuntime.applyExpoNativeBadgeState',
        });
    }, [badgeCount, isTauriDesktopHost, showNonNumericDot]);

    return null;
}
