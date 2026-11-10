import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DiscussionIdSchema, DiscussionMessageIdSchema } from './references.js';
import { PromptDocArtifactRefV1Schema } from '../prompts/library/promptArtifactRefsV1.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

/** Source-qualified identity only; Task read placement and authority remain Tasks-owned. */
const DiscussionTaskTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('task'),
  entry: asProtocolZod(TriageEntryRefV1Schema),
}));

/** Routing identity only; the passage quote/range belong in sealed message content. */
export const DiscussionDocPassageReplyTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('doc_passage'),
  doc: z.strictObject({
    ref: z.extend(PromptDocArtifactRefV1Schema, { serverId: DiscussionIdSchema }),
    revision: ArtifactRevisionV1Schema,
  }),
}));
export type DiscussionDocPassageReplyTargetV1 = z.infer<typeof DiscussionDocPassageReplyTargetV1Schema>;

/** The mutation owner resolves this message inside the current Discussion. */
export const DiscussionReplyTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), messageId: DiscussionMessageIdSchema }),
  DiscussionDocPassageReplyTargetV1Schema,
  DiscussionTaskTargetV1Schema,
]));
export type DiscussionReplyTargetV1 = z.infer<typeof DiscussionReplyTargetV1Schema>;

/** Optional identity links confer neither ownership nor access to their source. */
export const DiscussionAnchorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    sessionId: DiscussionIdSchema,
    messageId: z.optional(DiscussionMessageIdSchema),
  }),
  z.strictObject({
    kind: z.literal('doc'),
    doc: DiscussionDocPassageReplyTargetV1Schema.shape.doc,
  }),
  DiscussionTaskTargetV1Schema,
]));
export type DiscussionAnchorV1 = z.infer<typeof DiscussionAnchorV1Schema>;
