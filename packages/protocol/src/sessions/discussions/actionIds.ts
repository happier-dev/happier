import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The nine user-invocable human-discussion intents. People (UI/CLI) and
 * supported Agents reach the same durable discussions through these ids; there
 * is no Agent-specific discussion tool and no second discussion vocabulary.
 *
 * Automatic viewport cursor synchronization, draft synchronization, presence and
 * internal attention loading stay owner-native operations and deliberately have
 * no id here: an automatic foreground read observation must not become a tool
 * that lets an Agent mark a human's messages read.
 *
 * This leaf carries only the ids so the canonical Action id registry can import
 * it without pulling the discussion content schemas into that module graph.
 */
export const SESSION_DISCUSSION_ACTION_IDS_V1 = [
  'session.discussion.list',
  'session.discussion.get',
  'session.discussion.read',
  'session.discussion.create',
  'session.discussion.post',
  'session.discussion.rename',
  'session.discussion.archive',
  'session.discussion.restore',
  'session.discussion.read_state.set',
] as const;

export const SessionDiscussionActionIdV1Schema = lazyZodSchema(() => z.enum(SESSION_DISCUSSION_ACTION_IDS_V1));
export type SessionDiscussionActionIdV1 = z.infer<typeof SessionDiscussionActionIdV1Schema>;

const SESSION_DISCUSSION_ACTION_ID_SET: ReadonlySet<string> = new Set(SESSION_DISCUSSION_ACTION_IDS_V1);

export function isSessionDiscussionActionIdV1(value: string): value is SessionDiscussionActionIdV1 {
  return SESSION_DISCUSSION_ACTION_ID_SET.has(value);
}
