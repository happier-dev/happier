
/** Action identity leaf: schema modules and the registry share these constants. */
export const INBOX_GET_ACTION_ID_V1 = 'inbox.get' as const;
export const APP_SHELL_ACTION_IDS = ['session.work.get', INBOX_GET_ACTION_ID_V1, 'inbox.mark_all_read', 'inbox.notice.dismiss', 'session.draft.open', 'session.draft.delete', 'session.draft.directory.set', 'session.draft.model.set', 'session.draft.append'] as const;
