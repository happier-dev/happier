export const SESSION_ACTION_MARK_READ_ID = 'ui.session.mark-read';
export const SESSION_ACTION_FOLLOW_ID = 'ui.session.follow';
export const SESSION_ACTION_MARK_UNREAD_ID = 'ui.session.mark-unread';
export const SESSION_ACTION_RENAME_ID = 'ui.session.rename';
export const SESSION_ACTION_MAKE_BOT_ID = 'ui.session.make-bot';
export const SESSION_ACTION_MAKE_REGULAR_ID = 'ui.session.make-regular';
export const SESSION_ACTION_TOOL_CALLS_TOGGLE_ID = 'ui.session.tool-calls.toggle';
export const SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID = 'ui.session.tool-calls.use-default';
export const SESSION_ACTION_RESUME_ID = 'ui.session.resume';
export const SESSION_ACTION_STOP_ID = 'ui.session.stop';
export const SESSION_ACTION_ARCHIVE_ID = 'ui.session.archive';
export const SESSION_ACTION_UNARCHIVE_ID = 'ui.session.unarchive';
export const SESSION_ACTION_DELETE_ID = 'ui.session.delete';
export const SESSION_ACTION_PIN_ID = 'ui.session.pin';
export const SESSION_ACTION_UNPIN_ID = 'ui.session.unpin';
export const SESSION_ACTION_RAIL_PIN_ID = 'ui.session.rail.pin';
export const SESSION_ACTION_RAIL_UNPIN_ID = 'ui.session.rail.unpin';
export const SESSION_ACTION_WORK_OPEN_ID = 'ui.session.work.open';
export const SESSION_ACTION_TALK_ID = 'ui.session.talk';
export const SESSION_ACTION_EDIT_TAGS_ID = 'ui.session.tags.edit';
export const SESSION_ACTION_MOVE_TO_FOLDER_ID = 'ui.session.move-to-folder';
/** Row-menu submenu; offered only where the session's server stores session appearances. */
export const SESSION_ACTION_SET_APPEARANCE_COLOR_ID = 'ui.session.appearance-color';
export const SESSION_ACTION_SET_ATTENTION_STANDING_ID = 'ui.session.set-attention-standing';
export const SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID = 'ui.session.clear-attention-standing';
/** Puts the Session under a lead, or back at the top ("Put under…", the drag equivalent; ORC §3.8). */
export const SESSION_ACTION_PUT_UNDER_ID = 'ui.session.put-under';
/** Make coordinator… (C1 §6): opens the setup dialog; greyed with its reason when it already is one. */
export const SESSION_ACTION_COORDINATOR_MAKE_ID = 'ui.session.coordinator.make';
/** A coordinator's one toggle (C1 §6, Z21/Z28): its workers' non-approval questions reach it first. */
export const SESSION_ACTION_COORDINATOR_ANSWERS_ID = 'ui.session.coordinator.answers';
/** Edit what it follows: the coordinator's People pane, where its rules and managed sessions live. */
export const SESSION_ACTION_COORDINATOR_EDIT_ID = 'ui.session.coordinator.edit';
/** Stop coordinating: removes its rule follows through the Follow writer, with Undo. */
export const SESSION_ACTION_COORDINATOR_STOP_ID = 'ui.session.coordinator.stop';

export function resolveManualReadStateFromSessionActionId(actionId: string): 'read' | 'unread' | null {
    if (actionId === SESSION_ACTION_MARK_READ_ID) return 'read';
    if (actionId === SESSION_ACTION_MARK_UNREAD_ID) return 'unread';
    return null;
}

export function resolveAttentionStandingFromSessionActionId(actionId: string): boolean | null {
    if (actionId === SESSION_ACTION_SET_ATTENTION_STANDING_ID) return true;
    if (actionId === SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID) return false;
    return null;
}
