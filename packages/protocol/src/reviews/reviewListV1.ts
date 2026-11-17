import { z } from '../zodRuntimePolicy.js';
import { ReviewMetadataV1Schema } from './reviewArtifactV1.js';
import { ReviewListFilterV1Schema } from './reviewListFilterV1.js';
import { ResourceSpaceMembershipV1Schema } from '../collections/spaces/resourceSpaceMembershipV1.js';
import { ReviewCommentAppearanceInputV1Schema } from './comments/v1.js';

const id = z.string().check(z.minLength(1));
const ordinal = z.number().check(z.int(), z.minimum(1));
const timestamp = z.number().check(z.int(), z.minimum(0));

/** Structural selection only. Sealed title/content search stays within demanded results. */
export const ReviewListRequestV1Schema = z.strictObject({
  ...ReviewListFilterV1Schema.shape,
  limit: ordinal,
  cursor: z.optional(id),
  spaceId: z.optional(id),
  spaceMembershipMode: z.optional(ResourceSpaceMembershipV1Schema.shape.mode),
});
export type ReviewListRequestV1 = z.infer<typeof ReviewListRequestV1Schema>;

export const ReviewListItemV1Schema = z.strictObject({
  ...ReviewMetadataV1Schema.shape,
  reviewId: id,
  createdAt: timestamp,
  updatedAt: timestamp,
  counts: z.strictObject({ total: timestamp, needsDecision: timestamp }),
});
export type ReviewListItemV1 = z.infer<typeof ReviewListItemV1Schema>;
export const ReviewListResponseV1Schema = z.strictObject({ items: z.array(ReviewListItemV1Schema), cursor: z.nullable(id) });
export type ReviewListResponseV1 = z.infer<typeof ReviewListResponseV1Schema>;

export const ReviewWorkflowHistoryRequestV1Schema = z.strictObject({ workflowId: id, reviewId: id });
export type ReviewWorkflowHistoryRequestV1 = z.infer<typeof ReviewWorkflowHistoryRequestV1Schema>;
export const ReviewWorkflowHistoryResponseV1Schema = z.strictObject({
  previousReviewId: z.nullable(id),
  items: z.array(z.strictObject({
    findingIdentity: id,
    priorReviewCount: timestamp,
    priorRunCount: timestamp,
    firstObservedAt: timestamp,
    inCurrentReview: z.boolean(),
    inPreviousReview: z.boolean(),
    currentAppearances: z.array(ReviewCommentAppearanceInputV1Schema),
    previousAppearances: z.array(ReviewCommentAppearanceInputV1Schema),
    newSincePrevious: z.nullable(z.boolean()),
    openReviewCount: timestamp,
  })),
});
export type ReviewWorkflowHistoryResponseV1 = z.infer<typeof ReviewWorkflowHistoryResponseV1Schema>;
export const ReviewSeenBeforeRequestV1Schema = z.strictObject({ reviewId: id, findingIdentity: id });
export type ReviewSeenBeforeRequestV1 = z.infer<typeof ReviewSeenBeforeRequestV1Schema>;
export const ReviewSeenBeforeResponseV1Schema = z.strictObject({
  matches: z.array(z.strictObject({ reviewId: id, commentId: id, createdAt: timestamp })),
});
export type ReviewSeenBeforeResponseV1 = z.infer<typeof ReviewSeenBeforeResponseV1Schema>;
export const ReviewHistoryRequestV1Schema = z.union([ReviewWorkflowHistoryRequestV1Schema, ReviewSeenBeforeRequestV1Schema]);
export type ReviewHistoryRequestV1 = z.infer<typeof ReviewHistoryRequestV1Schema>;
export const ReviewHistoryResponseV1Schema = z.union([ReviewWorkflowHistoryResponseV1Schema, ReviewSeenBeforeResponseV1Schema]);
export type ReviewHistoryResponseV1 = z.infer<typeof ReviewHistoryResponseV1Schema>;
