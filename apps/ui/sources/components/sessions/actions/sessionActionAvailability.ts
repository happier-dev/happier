import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
} from './sessionActionIds';
import type { SessionActionId, SessionActionSurface, SessionActionTarget } from './sessionActionTypes';

export function resolveSessionReadStateActionId(target: SessionActionTarget): SessionActionId | null {
    if (!target.readStateAction.visible) return null;
    return target.readStateAction.targetState === 'read'
        ? SESSION_ACTION_MARK_READ_ID
        : SESSION_ACTION_MARK_UNREAD_ID;
}

export function listVisibleSessionActionIds(params: Readonly<{
    target: SessionActionTarget;
    surface: SessionActionSurface;
}>): SessionActionId[] {
    const { target, surface } = params;
    const ids: SessionActionId[] = [];
    const readStateId = resolveSessionReadStateActionId(target);

    if (readStateId) {
        ids.push(readStateId);
    }

    if (target.canRename) {
        ids.push(SESSION_ACTION_RENAME_ID);
    }

    if (target.isActive && target.canStop) {
        ids.push(SESSION_ACTION_STOP_ID);
    }

    if (target.canArchive) {
        ids.push(SESSION_ACTION_ARCHIVE_ID);
    }

    if (target.isArchived && target.hasAdminAccess) {
        ids.push(SESSION_ACTION_UNARCHIVE_ID);
    }

    if (surface === 'sessionInfo' && target.canDelete) {
        ids.push(SESSION_ACTION_DELETE_ID);
    }

    if (surface === 'rowMenu' || surface === 'nativeContextMenu') {
        ids.push(SESSION_ACTION_MOVE_TO_FOLDER_ID);
    }

    return ids;
}
