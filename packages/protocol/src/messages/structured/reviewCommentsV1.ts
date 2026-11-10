import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  WorkspaceAnchorResolutionV1Schema,
  WorkspaceAnchorSnapshotV1Schema,
  WorkspaceAnchorSourceV1Schema,
  WorkspaceAnchorV1Schema,
} from '../../workspace/anchors/v1.js';

/**
 * Canonical draft shape carried by the ordinary `review_comments.v1` message
 * envelope and by any pre-Session authoring custody that must reproduce it.
 */
export const ReviewCommentDraftMessageV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  filePath: z.string().check(z.minLength(1)),
  source: WorkspaceAnchorSourceV1Schema,
  anchor: WorkspaceAnchorV1Schema,
  anchorResolution: z.optional(WorkspaceAnchorResolutionV1Schema),
  snapshot: WorkspaceAnchorSnapshotV1Schema,
  body: z.string(),
  includeInPrompt: z.optional(z.boolean()),
  createdAt: z.number(),
}));

export type ReviewCommentDraftMessageV1 = z.infer<typeof ReviewCommentDraftMessageV1Schema>;

export const ReviewCommentsV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  comments: z.array(ReviewCommentDraftMessageV1Schema),
}));

export type ReviewCommentsV1 = z.infer<typeof ReviewCommentsV1Schema>;

export const ReviewCommentsMessageMetaV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('review_comments.v1'),
  payload: ReviewCommentsV1Schema,
}));
