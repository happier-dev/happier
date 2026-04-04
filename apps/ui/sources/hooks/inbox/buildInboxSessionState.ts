import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionAttentionFlags } from '@/sync/domains/session/attention/sessionAttention';
import { listPendingPermissionRequests, listPendingUserActionRequests, type PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

export type InboxSessionAttentionEntry = Readonly<{
    session: Session;
    pendingPermissions: readonly PendingPermissionRequest[];
    pendingUserActions: readonly PendingPermissionRequest[];
}>;

export type InboxSessionState = Readonly<{
    unreadSessions: Session[];
    sessionsNeedingAttention: InboxSessionAttentionEntry[];
}>;

export function buildInboxSessionState(sessions: readonly Session[]): InboxSessionState {
    const sessionsNeedingAttention: InboxSessionAttentionEntry[] = [];
    const attentionSessionIds = new Set<string>();

    for (const session of sessions) {
        if (session.presence !== 'online') continue;
        const pendingPermissions = listPendingPermissionRequests(session);
        const pendingUserActions = listPendingUserActionRequests(session);
        if (pendingPermissions.length === 0 && pendingUserActions.length === 0) continue;

        attentionSessionIds.add(session.id);
        sessionsNeedingAttention.push({
            session,
            pendingPermissions,
            pendingUserActions,
        });
    }

    const unreadSessions = sessions.filter((session) => {
        if (attentionSessionIds.has(session.id)) return false;
        return deriveSessionAttentionFlags(session, {
            showPendingPermissionRequests: false,
            showPendingUserActionRequests: false,
            showQueuedUserInput: false,
        }).hasUnread;
    });

    return {
        unreadSessions,
        sessionsNeedingAttention,
    };
}
