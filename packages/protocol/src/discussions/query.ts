import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { DiscussionIdSchema, DiscussionLocalIdSchema } from './content.js';
import { DiscussionListAnchorKindsV1Schema } from './listing/discussionListFilterV1.js';

const PageLimitSchema = lazyZodSchema(() => z.coerce.number().check(z.int(), z.minimum(1), z.maximum(100)));

/**
 * Discussion pages reuse the Session listing/transcript query-budget
 * convention: a bounded default page with a bounded caller override. The bound
 * belongs to the query owner, not to a count restriction on human messages.
 */
export const DISCUSSION_DEFAULT_PAGE_SIZE_V1 = 30;
export const DISCUSSION_MAX_PAGE_SIZE_V1 = 100;

export const DiscussionListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  sharedWithTeamId: z.optional(DiscussionIdSchema),
  state: z.optional(z.enum(['active', 'archived'])),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z.optional(PageLimitSchema),
  anchorKinds: z.optional(z.pipe(z.union([DiscussionListAnchorKindsV1Schema, DiscussionListAnchorKindsV1Schema.def.element]),
    z.transform(value => typeof value === 'string' ? [value] : value))),
  anchorSessionId: z.optional(DiscussionIdSchema),
  /** Preparation for one Doc in the authenticated Home; never an archived count. */
  anchorDocArtifactId: z.optional(DiscussionIdSchema),
  anchorTask: z.optional(z.pipe(z.transform(value => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
  }), asProtocolZod(TriageEntryRefV1Schema))),
  /** Reconciliation is always bound to the authenticated original creator. */
  creationLocalId: z.optional(DiscussionLocalIdSchema),
}).check(z.refine(value => value.anchorDocArtifactId === undefined || value.state !== 'archived',
  'Doc preparation lists active Discussions only'),
z.refine(value => !value.anchorTask || (value.anchorSessionId === undefined && value.anchorDocArtifactId === undefined
  && value.anchorKinds === undefined && value.creationLocalId === undefined && value.sharedWithTeamId === undefined
  && value.cursor === undefined && value.limit === undefined), 'A Task anchor selects one Discussion')));
export type DiscussionListQueryV1 = z.infer<typeof DiscussionListQueryV1Schema>;

/** Exact selectors narrow a read; they cannot also select a history page. */
export function isDiscussionMessagesSelectionValidV1(value: Readonly<{
  messageId?: string; localId?: string; beforeSeq?: number; afterSeq?: number; limit?: number;
}>): boolean {
  if (value.beforeSeq !== undefined && value.afterSeq !== undefined) return false;
  if (value.messageId !== undefined && value.localId !== undefined) return false;
  return value.messageId === undefined && value.localId === undefined
    || value.beforeSeq === undefined && value.afterSeq === undefined && value.limit === undefined;
}

export const DiscussionMessagesQueryV1Schema = lazyZodSchema(() => z.strictObject({
  messageId: z.optional(DiscussionIdSchema),
  /** Correlation is private to messages authored by the authenticated reader. */
  localId: z.optional(DiscussionLocalIdSchema),
  beforeSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(1))),
  afterSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
  limit: z.optional(PageLimitSchema),
  throughSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
}).check(z.refine(isDiscussionMessagesSelectionValidV1, 'Exact message selection and history paging are mutually exclusive')));
export type DiscussionMessagesQueryV1 = z.infer<typeof DiscussionMessagesQueryV1Schema>;

