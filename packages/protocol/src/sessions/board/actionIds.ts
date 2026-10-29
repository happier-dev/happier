import { SESSION_BOARD_ACTION_IDS_V1 } from './idsV1.js';
export { SESSION_BOARD_ACTION_IDS_V1 } from './idsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const SessionBoardActionIdV1Schema = lazyZodSchema(() => z.enum(SESSION_BOARD_ACTION_IDS_V1));
export type SessionBoardActionIdV1 = z.infer<typeof SessionBoardActionIdV1Schema>;

export const SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 = Object.freeze({
  'session.board.get': 'session_board_get',
  'session.board.item.upsert': 'session_board_item_upsert',
  'session.board.item.remove': 'session_board_item_remove',
  'session.board.layout.update': 'session_board_layout_update',
} satisfies Record<SessionBoardActionIdV1, string>);

const SESSION_BOARD_ACTION_ID_SET: ReadonlySet<string> = new Set(SESSION_BOARD_ACTION_IDS_V1);

export function isSessionBoardActionIdV1(value: string): value is SessionBoardActionIdV1 {
  return SESSION_BOARD_ACTION_ID_SET.has(value);
}
