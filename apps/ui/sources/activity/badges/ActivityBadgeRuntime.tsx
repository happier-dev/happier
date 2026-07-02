import * as React from 'react';

import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { storage, useFriendRequests, useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { applyExpoNativeBadgeState } from './channels/applyExpoNativeBadgeState';
import { applyTauriBadgeState } from './channels/applyTauriBadgeState';
import {
    createLocalActivityBadgeSnapshotSelector,
    type LocalActivityBadgeSnapshot,
    type LocalActivityBadgeSnapshotSelectorParams,
} from './createLocalActivityBadgeSnapshotSelector';

type ServerBadgeSnapshot = Readonly<{
    count: number;
    serverGeneration: number;
    serverId: string;
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

function canUseServerBadgeSnapshot(options: LocalActivityBadgeSnapshot['sessionOptions']): boolean {
    return options.showUnread
        && options.showPendingPermissionRequests
        && options.showPendingUserActionRequests;
}

function useActivityBadgeLocalSettingsInput(): LocalActivityBadgeSnapshotSelectorParams['localSettings'] {
    const attentionDeviceOverridesV1 = useLocalSetting('attentionDeviceOverridesV1');
    const activityBadgesEnabled = useLocalSetting('activityBadgesEnabled');
    const activityBadgeShowUnread = useLocalSetting('activityBadgeShowUnread');
    const activityBadgeShowPendingPermissionRequests = useLocalSetting('activityBadgeShowPendingPermissionRequests');
    const activityBadgeShowPendingUserActionRequests = useLocalSetting('activityBadgeShowPendingUserActionRequests');
    const activityBadgeShowQueuedUserInput = useLocalSetting('activityBadgeShowQueuedUserInput');
    const activityBadgeShowFriendRequestsInboxCount = useLocalSetting('activityBadgeShowFriendRequestsInboxCount');
    const activityBadgeShowDesktopNonNumericDot = useLocalSetting('activityBadgeShowDesktopNonNumericDot');

    return React.useMemo(() => ({
        attentionDeviceOverridesV1,
        activityBadgesEnabled,
        activityBadgeShowUnread,
        activityBadgeShowPendingPermissionRequests,
        activityBadgeShowPendingUserActionRequests,
        activityBadgeShowQueuedUserInput,
        activityBadgeShowFriendRequestsInboxCount,
        activityBadgeShowDesktopNonNumericDot,
    }), [
        activityBadgeShowDesktopNonNumericDot,
        activityBadgeShowFriendRequestsInboxCount,
        activityBadgeShowPendingPermissionRequests,
        activityBadgeShowPendingUserActionRequests,
        activityBadgeShowQueuedUserInput,
        activityBadgeShowUnread,
        activityBadgesEnabled,
        attentionDeviceOverridesV1,
    ]);
}

function useActivityBadgeAccountSettingsInput(): LocalActivityBadgeSnapshotSelectorParams['accountSettings'] {
    const attentionDeliveryPolicyV1 = useSetting('attentionDeliveryPolicyV1');
    return React.useMemo(() => ({
        attentionDeliveryPolicyV1,
    }), [attentionDeliveryPolicyV1]);
}

function useLocalActivityBadgeSnapshot(
    params: LocalActivityBadgeSnapshotSelectorParams,
): LocalActivityBadgeSnapshot {
    const selector = React.useMemo(
        () => createLocalActivityBadgeSnapshotSelector(params),
        [params],
    );
    return storage(useShallow(selector));
}

export function ActivityBadgeRuntime(): React.ReactElement | null {
    const friendRequests = useFriendRequests();
    const localSettings = useActivityBadgeLocalSettingsInput();
    const accountSettings = useActivityBadgeAccountSettingsInput();
    const activeServer = useActiveServerSnapshot();
    const { updateAvailable } = useUpdates();
    const { hasUnread: changelogHasUnread } = useChangelog();
    const isTauriDesktopHost = isTauriDesktop();
    const shouldApplyBadgeRuntime = isTauriDesktopHost || Platform.OS !== 'web';
    const [serverBadgeSnapshot, setServerBadgeSnapshot] = React.useState<ServerBadgeSnapshot | null>(null);
    const hasNonNumericInboxAttention = updateAvailable || changelogHasUnread;
    const badgeSnapshotParams = React.useMemo<LocalActivityBadgeSnapshotSelectorParams>(() => ({
        accountSettings,
        friendRequestCount: friendRequests.length,
        hasNonNumericInboxAttention,
        localSettings,
    }), [
        accountSettings,
        friendRequests.length,
        hasNonNumericInboxAttention,
        localSettings,
    ]);
    const localBadgeSnapshot = useLocalActivityBadgeSnapshot(badgeSnapshotParams);

    const serverSnapshotAllowed = !localBadgeSnapshot.channelDisabled
        && canUseServerBadgeSnapshot(localBadgeSnapshot.sessionOptions);

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
        if (localBadgeSnapshot.channelDisabled) return localBadgeSnapshot.localBadgeState;
        if (localBadgeSnapshot.isDataReady || localBadgeSnapshot.hasLocalActivitySource) {
            return localBadgeSnapshot.localBadgeState;
        }
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
        localBadgeSnapshot,
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
