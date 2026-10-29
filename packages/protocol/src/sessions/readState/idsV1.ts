
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * The one user-invocable Session read-state intent (Lane 09B §5.3).
 *
 * Explicit mark-read/mark-unread requests, including Agent requests, use this
 * Action. Automatic viewport synchronization stays an internal observation
 * operation and deliberately has no separate Action id.
 *
 * This leaf carries only the id so the canonical Action id registry can import
 * it without pulling the read-state content schemas into that module graph.
 */
export const SESSION_READ_STATE_ACTION_IDS_V1 = [
  'session.read_state.set',
] as const;
