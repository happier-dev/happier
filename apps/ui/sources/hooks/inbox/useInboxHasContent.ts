import { useUpdates } from './useUpdates';
import {
    useAllSessionListRenderablesForAttention,
    useAllSessionsForAttention,
    useArtifacts,
    useFeedItems,
    useFriendRequests,
    useRequestedFriends,
} from '@/sync/domains/state/storage';
import { useChangelog } from './useChangelog';
import { buildInboxSessionState } from './buildInboxSessionState';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const changelog = useChangelog();
    const artifacts = useArtifacts();
    const sessions = useAllSessionsForAttention();
    const sessionRows = useAllSessionListRenderablesForAttention();
    const { unreadSessions, sessionsNeedingAttention } = buildInboxSessionState({ sessions, sessionRows });

    const hasOpenApprovals = artifacts.some(
        (a) => a.header?.kind === 'approval_request.v1' && a.header?.approvalStatus === 'open'
    );

    // Show dot if there's any actionable content:
    // - App updates available
    // - Pending approvals
    // - Pending permission / user action requests
    // - Unread sessions
    // - Incoming friend requests (also shown as badge)
    // - Outgoing friend requests pending
    // - Feed items (activity updates)
    // - Unread changelog entries
    return (
        updateAvailable ||
        hasOpenApprovals ||
        sessionsNeedingAttention.length > 0 ||
        unreadSessions.length > 0 ||
        friendRequests.length > 0 ||
        requestedFriends.length > 0 ||
        feedItems.length > 0 ||
        (changelog.hasUnread === true)
    );
}
