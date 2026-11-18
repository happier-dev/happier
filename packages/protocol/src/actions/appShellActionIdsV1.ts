
/** Action identity leaf: schema modules and the registry share these constants. */
export const INBOX_GET_ACTION_ID_V1 = 'inbox.get' as const;
export const INBOX_NOTICE_DISMISS_ACTION_ID_V1 = 'inbox.notice.dismiss' as const;
export const INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1 = 'inbox.notice.reminder.set' as const;
export function isAccountNoticeMutationActionIdV1(id: string): id is typeof INBOX_NOTICE_DISMISS_ACTION_ID_V1 | typeof INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1 {
    return id === INBOX_NOTICE_DISMISS_ACTION_ID_V1 || id === INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1;
}
export const SESSION_DRAFT_DIRECTORY_SET_ACTION_ID_V1 = 'session.draft.directory.set' as const;
export const SESSION_DRAFT_MODEL_SET_ACTION_ID_V1 = 'session.draft.model.set' as const;
export const SESSION_DRAFT_AGENT_SET_ACTION_ID_V1 = 'session.draft.agent.set' as const;
export function isNewSessionDraftEditActionIdV1(actionId: string): actionId is
    typeof SESSION_DRAFT_DIRECTORY_SET_ACTION_ID_V1 | typeof SESSION_DRAFT_MODEL_SET_ACTION_ID_V1 | typeof SESSION_DRAFT_AGENT_SET_ACTION_ID_V1 {
    return actionId === SESSION_DRAFT_DIRECTORY_SET_ACTION_ID_V1
        || actionId === SESSION_DRAFT_MODEL_SET_ACTION_ID_V1
        || actionId === SESSION_DRAFT_AGENT_SET_ACTION_ID_V1;
}
export const APP_SHELL_ACTION_IDS = ['session.work.get', INBOX_GET_ACTION_ID_V1, 'inbox.mark_all_read', INBOX_NOTICE_DISMISS_ACTION_ID_V1, INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1, 'session.draft.open', 'session.draft.delete', SESSION_DRAFT_DIRECTORY_SET_ACTION_ID_V1, SESSION_DRAFT_MODEL_SET_ACTION_ID_V1, SESSION_DRAFT_AGENT_SET_ACTION_ID_V1, 'session.draft.append'] as const;
