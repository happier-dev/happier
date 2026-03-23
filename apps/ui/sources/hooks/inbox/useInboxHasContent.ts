import { useUpdates } from './useUpdates';
import { useAllSessions, useArtifacts, useFeedItems, useFriendRequests, useRequestedFriends } from '@/sync/domains/state/storage';
import { useChangelog } from './useChangelog';
import { listPendingPermissionRequests, listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const changelog = useChangelog();
    const artifacts = useArtifacts();
    const sessions = useAllSessions();

    const hasOpenApprovals = artifacts.some(
        (a) => a.header?.kind === 'approval_request.v1' && a.header?.approvalStatus === 'open'
    );

    const hasOnlineSessionsWithPendingRequests = sessions.some((s) => {
        if (s.presence !== 'online') return false;
        return listPendingPermissionRequests(s).length > 0 || listPendingUserActionRequests(s).length > 0;
    });

    // Show dot if there's any actionable content:
    // - App updates available
    // - Pending approvals
    // - Pending permission / user action requests
    // - Incoming friend requests (also shown as badge)
    // - Outgoing friend requests pending
    // - Feed items (activity updates)
    // - Unread changelog entries
    return (
        updateAvailable ||
        hasOpenApprovals ||
        hasOnlineSessionsWithPendingRequests ||
        friendRequests.length > 0 ||
        requestedFriends.length > 0 ||
        feedItems.length > 0 ||
        (changelog.hasUnread === true)
    );
}
