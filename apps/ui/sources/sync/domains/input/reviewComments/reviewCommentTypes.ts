import type {
    ReviewCommentDraftMessageV1} from '@happier-dev/protocol/messages/structured/reviewCommentsV1';
import type {
    WorkspaceAnchorSnapshotV1,
    WorkspaceAnchorSourceV1,
    WorkspaceAnchorV1,
} from '@happier-dev/protocol/workspace/anchors/v1';

/**
 * The review-comment draft vocabulary is owned by `@happier-dev/protocol`
 * (`review_comments.v1` and the workspace-anchor schemas it composes). These
 * aliases keep the UI's local names while the protocol types stay the single
 * source of truth for the shape.
 */
export type ReviewCommentSource = WorkspaceAnchorSourceV1;

export type ReviewCommentAnchor = WorkspaceAnchorV1;

export type ReviewCommentSnapshot = WorkspaceAnchorSnapshotV1;

export type ReviewCommentDraft = ReviewCommentDraftMessageV1;
