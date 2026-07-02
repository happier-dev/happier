import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useUpdates } from './useUpdates';
import {
    getStorage,
    useAllSessionListAttentionRows,
    useAllSessionsForAttention,
    useArtifacts,
    useFeedItems,
    useFriendRequests,
    useRequestedFriends,
} from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { useChangelog } from './useChangelog';
import { createInboxSessionContentSelector } from './createInboxSessionContentSelector';

function collectInboxSessionMessageIds(params: Readonly<{
    sessions: ReturnType<typeof useAllSessionsForAttention>;
    sessionRows: ReturnType<typeof useAllSessionListAttentionRows>;
}>): string[] {
    const ids = new Set<string>();
    for (const session of params.sessions) {
        const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
        if (sessionId) ids.add(sessionId);
    }
    for (const row of params.sessionRows) {
        const sessionId = typeof row.session.id === 'string' ? row.session.id.trim() : '';
        if (sessionId) ids.add(sessionId);
    }
    return Array.from(ids).sort();
}

function useInboxSessionMessagesById(
    sessionIds: readonly string[],
): StorageState['sessionMessages'] {
    return getStorage()(useShallow((state) => {
        const out: StorageState['sessionMessages'] = {};
        for (const sessionId of sessionIds) {
            const sessionMessages = state.sessionMessages[sessionId];
            if (sessionMessages) {
                out[sessionId] = sessionMessages;
            }
        }
        return out;
    }));
}

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const changelog = useChangelog();
    const artifacts = useArtifacts();
    const sessions = useAllSessionsForAttention();
    const sessionRows = useAllSessionListAttentionRows();
    const sessionMessageIds = React.useMemo(() => collectInboxSessionMessageIds({
        sessions,
        sessionRows,
    }), [sessions, sessionRows]);
    const sessionMessagesById = useInboxSessionMessagesById(sessionMessageIds);
    const selectInboxSessionContent = React.useMemo(() => createInboxSessionContentSelector(), []);
    const hasSessionContent = selectInboxSessionContent({
        sessions,
        sessionRows,
        sessionMessagesById,
    });

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
        hasSessionContent ||
        friendRequests.length > 0 ||
        requestedFriends.length > 0 ||
        feedItems.length > 0 ||
        (changelog.hasUnread === true)
    );
}
