import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
} from './sessionActionIds';
import type { SessionActionId, SessionActionSurface, SessionActionTarget } from './sessionActionTypes';

export function resolveSessionReadStateActionId(target: SessionActionTarget): SessionActionId | null {
    if (!target.readStateAction.visible) return null;
    return target.readStateAction.targetState === 'read'
        ? SESSION_ACTION_MARK_READ_ID
        : SESSION_ACTION_MARK_UNREAD_ID;
}

export function resolveSessionAttentionStandingActionId(target: SessionActionTarget): SessionActionId | null {
    if (!target.attentionStandingAction.visible) return null;
    return target.attentionStandingAction.targetStanding
        ? SESSION_ACTION_SET_ATTENTION_STANDING_ID
        : SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID;
}

export function listVisibleSessionActionIds(params: Readonly<{
    target: SessionActionTarget;
    surface: SessionActionSurface;
    /**
     * Whether the session's server stores per-session colours (`useSessionAppearancesSupported`).
     * Read by menus only while open; the colour action's whole gate is decided here.
     */
    sessionAppearancesSupported?: boolean;
}>): SessionActionId[] {
    const { target, surface } = params;
    const ids: SessionActionId[] = [];
    const readStateId = resolveSessionReadStateActionId(target);

    if (readStateId) {
        ids.push(readStateId);
    }

    const attentionStandingId = resolveSessionAttentionStandingActionId(target);
    if (attentionStandingId) {
        ids.push(attentionStandingId);
    }

    if (target.canRename) {
        ids.push(SESSION_ACTION_RENAME_ID);
    }

    // A colour is the person's own organization (like a pin), so access level does not gate it; the
    // session needs a server, and that server must store session colours. The info screen lists
    // lifecycle and details, not organization, so it does not offer it.
    if ((surface === 'rowMenu' || surface === 'nativeContextMenu' || surface === 'sessionHeader')
        && target.serverId
        && params.sessionAppearancesSupported === true) {
        ids.push(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
    }

    if (surface === 'sessionHeader' && target.serverId && !target.isArchived) {
        ids.push(target.isPinned ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID);
    }

    if (surface === 'sessionHeader' && target.canResume) {
        ids.push(SESSION_ACTION_RESUME_ID);
    }

    if ((target.isActive || target.hasStoppableTerminalHost) && target.canStop) {
        ids.push(SESSION_ACTION_STOP_ID);
    }

    if (target.canArchive) {
        ids.push(SESSION_ACTION_ARCHIVE_ID);
    }

    if (target.isArchived && target.hasAdminAccess) {
        ids.push(SESSION_ACTION_UNARCHIVE_ID);
    }

    if (surface !== 'selectionActionBar' && (target.canDelete || target.canStopAndDelete)) {
        ids.push(SESSION_ACTION_DELETE_ID);
    }

    if (surface === 'rowMenu' || surface === 'nativeContextMenu') {
        ids.push(SESSION_ACTION_MOVE_TO_FOLDER_ID);
    }

    return ids;
}
