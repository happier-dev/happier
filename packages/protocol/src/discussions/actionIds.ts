import { DISCUSSION_ACTION_IDS_V1 } from './idsV1.js';
export { DISCUSSION_ACTION_IDS_V1 } from './idsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const DiscussionActionIdV1Schema = lazyZodSchema(() => z.enum(DISCUSSION_ACTION_IDS_V1));
export type DiscussionActionIdV1 = z.infer<typeof DiscussionActionIdV1Schema>;

const DISCUSSION_ACTION_ID_SET: ReadonlySet<string> = new Set(DISCUSSION_ACTION_IDS_V1);

export function isDiscussionActionIdV1(value: string): value is DiscussionActionIdV1 {
  return DISCUSSION_ACTION_ID_SET.has(value);
}

export function isDiscussionReplyActionIdV1(value: string): value is 'discussion.reply' {
  return value === 'discussion.reply';
}
