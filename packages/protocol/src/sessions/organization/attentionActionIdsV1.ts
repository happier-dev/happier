
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * `session.attention.set` (ORC R-10): the one Action over the existing attention-standing route.
 *
 * Settle is `{ standing: false }` (paired with `session.read_state.set`), snooze is `{ remindAt }`,
 * and a null clears that field. It adds no storage and no second writer: the server's
 * standing route stays the only persistence owner, and this Action only names it.
 */
export const SESSION_ATTENTION_SET_ACTION_ID = 'session.attention.set' as const;
