
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * The four user-invocable Board intents. People (UI/CLI) and supported Agents
 * reach the same durable Board through these ids; there is no Agent-specific
 * Board tool and no second Board vocabulary.
 *
 * This leaf carries identities and their tool bindings without loading document
 * schemas or the complete Action catalog into read-only viewers.
 */
export const SESSION_BOARD_ACTION_IDS_V1 = [
  'session.board.get',
  'session.board.item.upsert',
  'session.board.item.remove',
  'session.board.layout.update',
] as const;
