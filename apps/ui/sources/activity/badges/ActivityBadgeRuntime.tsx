import * as React from 'react';

import { Platform } from 'react-native';

import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useAllSessions, useFriendRequests, useLocalSettings } from '@/sync/domains/state/storage';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityBadgeState } from './buildActivityBadgeState';
import { applyExpoNativeBadgeState } from './channels/applyExpoNativeBadgeState';
import { applyTauriBadgeState } from './channels/applyTauriBadgeState';

export function ActivityBadgeRuntime(): React.ReactElement | null {
    const sessions = useAllSessions();
    const friendRequests = useFriendRequests();
    const localSettings = useLocalSettings();
    const { updateAvailable } = useUpdates();
    const { hasUnread: changelogHasUnread } = useChangelog();

    const badgeState = React.useMemo(() => {
        if (localSettings.activityBadgesEnabled === false) {
            return { count: 0, showNonNumericDot: false };
        }

        return buildActivityBadgeState({
            sessions,
            numericInboxCount:
                localSettings.activityBadgeShowFriendRequestsInboxCount === false
                    ? 0
                    : friendRequests.length,
            hasNonNumericInboxAttention:
                localSettings.activityBadgeShowDesktopNonNumericDot !== false &&
                (updateAvailable || changelogHasUnread),
            sessionOptions: {
                showUnread: localSettings.activityBadgeShowUnread !== false,
                showPendingPermissionRequests:
                    localSettings.activityBadgeShowPendingPermissionRequests !== false,
                showPendingUserActionRequests:
                    localSettings.activityBadgeShowPendingUserActionRequests !== false,
                showQueuedUserInput: localSettings.activityBadgeShowQueuedUserInput !== false,
            },
        });
    }, [
        changelogHasUnread,
        friendRequests.length,
        localSettings.activityBadgeShowDesktopNonNumericDot,
        localSettings.activityBadgeShowFriendRequestsInboxCount,
        localSettings.activityBadgeShowPendingPermissionRequests,
        localSettings.activityBadgeShowPendingUserActionRequests,
        localSettings.activityBadgeShowQueuedUserInput,
        localSettings.activityBadgeShowUnread,
        localSettings.activityBadgesEnabled,
        sessions,
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
