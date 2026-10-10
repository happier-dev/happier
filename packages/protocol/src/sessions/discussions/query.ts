import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

const PageLimitSchema = lazyZodSchema(() => z.coerce.number().int().min(1).max(100));

/**
 * Discussion pages reuse the Session listing/transcript query-budget
 * convention: a bounded default page with a bounded caller override. The bound
 * belongs to the query owner, not to a count restriction on human messages.
 */
export const SESSION_DISCUSSION_DEFAULT_PAGE_SIZE_V1 = 30;
export const SESSION_DISCUSSION_MAX_PAGE_SIZE_V1 = 100;

export const SessionDiscussionListQueryV1Schema = lazyZodSchema(() => z.object({
  state: z.enum(['active', 'archived']).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: PageLimitSchema.optional(),
}).strict());
export type SessionDiscussionListQueryV1 = z.infer<typeof SessionDiscussionListQueryV1Schema>;

export const SessionDiscussionMessagesQueryV1Schema = lazyZodSchema(() => z.object({
  beforeSeq: z.coerce.number().int().min(1).optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: PageLimitSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.beforeSeq !== undefined && value.afterSeq !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['afterSeq'],
      message: 'beforeSeq and afterSeq are mutually exclusive',
    });
  }
}));
export type SessionDiscussionMessagesQueryV1 = z.infer<typeof SessionDiscussionMessagesQueryV1Schema>;
