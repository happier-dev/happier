import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import type { SessionBulkActionTarget } from '@/components/sessions/actions/sessionBulkActionTypes';
import { resolveSessionAttentionStanding } from '@/sync/domains/session/organization/attentionStanding';

import { sessionTagKey } from '../sessionTagUtils';
import type {
    SessionListRowPresentationSettings,
    SessionListSessionItem,
} from '../row/sessionListRowModelTypes';

/**
 * The selection bar's view of one row, derived from the same action target the row menu uses so a
 * session cannot be offered one thing in its own menu and the opposite in multi-select.
 */
export function buildSessionBulkActionTargetFromSessionItem(
    item: SessionListSessionItem,
    settings: SessionListRowPresentationSettings,
): SessionBulkActionTarget {
    const sessionId = String(item.session.id);
    const serverId = typeof item.serverId === 'string' && item.serverId.trim()
        ? item.serverId.trim()
        : null;
    const rowKey = serverId ? sessionTagKey(serverId, sessionId) : sessionId;
    const actionTarget = createSessionActionTarget({
        session: item.session,
        serverId,
        currentUserId: settings.currentUserId,
        isConnected: item.session.active === true,
        isPinned: item.pinned === true || settings.pinnedSessionKeys.includes(rowKey),
        attentionStandingEnabled: settings.attentionStandingEnabled,
        attentionStanding: resolveSessionAttentionStanding(settings.attentionStandingPolicy, rowKey),
    });
    const readState = actionTarget.readStateAction.visible
        ? actionTarget.readStateAction.targetState === 'read'
            ? 'unread'
            : 'read'
        : undefined;
    // Left undefined when the action is unreachable (band off, archived, view-only) so the bulk bar
    // offers neither direction rather than inventing one.
    const standing = actionTarget.attentionStandingAction.visible
        ? actionTarget.attentionStandingAction.targetStanding === false
        : undefined;

    return {
        key: rowKey,
        sessionId,
        serverId,
        active: actionTarget.isActive,
        archived: actionTarget.isArchived,
        hasAdminAccess: actionTarget.hasAdminAccess,
        canStop: actionTarget.canStop,
        canArchive: actionTarget.canArchive,
        pinned: actionTarget.isPinned,
        tags: settings.sessionTagsByKey[rowKey] ?? [],
        readState,
        standing,
    };
}
