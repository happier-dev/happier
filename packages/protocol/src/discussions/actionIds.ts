import { DISCUSSION_ACTION_IDS_V1 } from './idsV1.js';
export { DISCUSSION_ACTION_IDS_V1 } from './idsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

/**
 * User-invocable Home Discussion intents. People (UI/CLI) and
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


export const DiscussionActionIdV1Schema = lazyZodSchema(() => z.enum(DISCUSSION_ACTION_IDS_V1));
export type DiscussionActionIdV1 = z.infer<typeof DiscussionActionIdV1Schema>;

const DISCUSSION_ACTION_ID_SET: ReadonlySet<string> = new Set(DISCUSSION_ACTION_IDS_V1);

export function isDiscussionActionIdV1(value: string): value is DiscussionActionIdV1 {
  return DISCUSSION_ACTION_ID_SET.has(value);
}

