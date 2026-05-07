import * as React from 'react';

import { Platform } from 'react-native';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { resolveActivityAttentionSessions } from '@/activity/attention/activityAttentionSessions';
import {
    useAllSessionListRenderablesForAttention,
    useAllSessionsForAttention,
    useFriendRequests,
    useIsDataReady,
    useLocalSettings,
} from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityBadgeState } from './buildActivityBadgeState';
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
    showQueuedUserInput: boolean;
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
        && options.showPendingUserActionRequests
        && options.showQueuedUserInput;
}

export function ActivityBadgeRuntime(): React.ReactElement | null {
    const sessions = useAllSessionsForAttention();
    const sessionListRenderables = useAllSessionListRenderablesForAttention();
    const isDataReady = useIsDataReady();
    const friendRequests = useFriendRequests();
    const localSettings = useLocalSettings();
    const activeServer = useActiveServerSnapshot();
    const { updateAvailable } = useUpdates();
    const { hasUnread: changelogHasUnread } = useChangelog();
    const isTauriDesktopHost = isTauriDesktop();
    const shouldApplyBadgeRuntime = isTauriDesktopHost || Platform.OS !== 'web';
    const [serverBadgeSnapshot, setServerBadgeSnapshot] = React.useState<ServerBadgeSnapshot | null>(null);

    const sessionOptions = React.useMemo<ActivityBadgeSessionOptions>(() => ({
        showUnread: localSettings.activityBadgeShowUnread !== false,
        showPendingPermissionRequests:
            localSettings.activityBadgeShowPendingPermissionRequests !== false,
        showPendingUserActionRequests:
            localSettings.activityBadgeShowPendingUserActionRequests !== false,
        showQueuedUserInput: localSettings.activityBadgeShowQueuedUserInput !== false,
    }), [
        localSettings.activityBadgeShowPendingPermissionRequests,
        localSettings.activityBadgeShowPendingUserActionRequests,
        localSettings.activityBadgeShowQueuedUserInput,
        localSettings.activityBadgeShowUnread,
    ]);

    const badgesEnabled = localSettings.activityBadgesEnabled !== false;
    const serverSnapshotAllowed = badgesEnabled && canUseServerBadgeSnapshot(sessionOptions);

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

    const localBadgeState = React.useMemo(() => {
        if (!badgesEnabled) {
            return { count: 0, showNonNumericDot: false };
        }

        const badgeSessions = resolveActivityAttentionSessions({
            sessions,
            sessionRows: sessionListRenderables,
        });
        return buildActivityBadgeState({
            sessions: badgeSessions,
            numericInboxCount:
                localSettings.activityBadgeShowFriendRequestsInboxCount === false
                    ? 0
                    : friendRequests.length,
            hasNonNumericInboxAttention:
                localSettings.activityBadgeShowDesktopNonNumericDot !== false &&
                (updateAvailable || changelogHasUnread),
            sessionOptions,
        });
    }, [
        badgesEnabled,
        changelogHasUnread,
        friendRequests.length,
        localSettings.activityBadgeShowDesktopNonNumericDot,
        localSettings.activityBadgeShowFriendRequestsInboxCount,
        sessionOptions,
        sessionListRenderables,
        sessions,
        updateAvailable,
    ]);

    const hasLocalBadgeSource = sessions.length > 0 || sessionListRenderables.length > 0;

    const badgeState = React.useMemo(() => {
        if (!badgesEnabled) return localBadgeState;
        if (isDataReady || hasLocalBadgeSource) return localBadgeState;
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
        badgesEnabled,
        hasLocalBadgeSource,
        isDataReady,
        localBadgeState,
        serverBadgeSnapshot,
        serverSnapshotAllowed,
    ]);

    React.useEffect(() => {
        if (!badgeState) return;

        if (isTauriDesktopHost) {
            fireAndForget(applyTauriBadgeState(badgeState), {
                tag: 'ActivityBadgeRuntime.applyTauriBadgeState',
            });
            return;
        }

        if (Platform.OS === 'web') return;

        fireAndForget(applyExpoNativeBadgeState(badgeState), {
            tag: 'ActivityBadgeRuntime.applyExpoNativeBadgeState',
        });
    }, [badgeState, isTauriDesktopHost]);

    return null;
}
