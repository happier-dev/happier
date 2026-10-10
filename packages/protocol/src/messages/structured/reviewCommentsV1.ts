import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

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
export const ReviewCommentDraftMessageV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  source: WorkspaceAnchorSourceV1Schema,
  anchor: WorkspaceAnchorV1Schema,
  anchorResolution: WorkspaceAnchorResolutionV1Schema.optional(),
  snapshot: WorkspaceAnchorSnapshotV1Schema,
  body: z.string(),
  includeInPrompt: z.boolean().optional(),
  createdAt: z.number(),
}).strict());

export type ReviewCommentDraftMessageV1 = z.infer<typeof ReviewCommentDraftMessageV1Schema>;

export const ReviewCommentsV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  comments: z.array(ReviewCommentDraftMessageV1Schema),
}).strict());

export type ReviewCommentsV1 = z.infer<typeof ReviewCommentsV1Schema>;
