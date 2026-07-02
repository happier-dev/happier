export const SESSION_ACTION_MARK_READ_ID = 'ui.session.mark-read';
export const SESSION_ACTION_MARK_UNREAD_ID = 'ui.session.mark-unread';
export const SESSION_ACTION_RENAME_ID = 'ui.session.rename';
export const SESSION_ACTION_STOP_ID = 'ui.session.stop';
export const SESSION_ACTION_ARCHIVE_ID = 'ui.session.archive';
export const SESSION_ACTION_UNARCHIVE_ID = 'ui.session.unarchive';
export const SESSION_ACTION_DELETE_ID = 'ui.session.delete';
export const SESSION_ACTION_PIN_ID = 'ui.session.pin';
export const SESSION_ACTION_UNPIN_ID = 'ui.session.unpin';
export const SESSION_ACTION_EDIT_TAGS_ID = 'ui.session.tags.edit';
export const SESSION_ACTION_MOVE_TO_FOLDER_ID = 'ui.session.move-to-folder';

export function resolveManualReadStateFromSessionActionId(actionId: string): 'read' | 'unread' | null {
    if (actionId === SESSION_ACTION_MARK_READ_ID) return 'read';
    if (actionId === SESSION_ACTION_MARK_UNREAD_ID) return 'unread';
    return null;
}
