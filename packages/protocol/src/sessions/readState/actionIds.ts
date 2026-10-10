import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

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

export const SessionReadStateActionIdV1Schema = lazyZodSchema(() => z.enum(SESSION_READ_STATE_ACTION_IDS_V1));
export type SessionReadStateActionIdV1 = z.infer<typeof SessionReadStateActionIdV1Schema>;

const SESSION_READ_STATE_ACTION_ID_SET: ReadonlySet<string> = new Set(SESSION_READ_STATE_ACTION_IDS_V1);

export function isSessionReadStateActionIdV1(value: string): value is SessionReadStateActionIdV1 {
  return SESSION_READ_STATE_ACTION_ID_SET.has(value);
}
