import {
    buildReviewCommentTextSnapshotHashes,
    reviewCommentTextSnapshotHasBidiControlsV1,
    reviewCommentTextSnapshotIsLikelyMinifiedV1,
} from '@happier-dev/protocol/reviews/comments/snapshots';
import type { ReviewCommentCreateRequestV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type {
    ReviewCommentCreateResponseV1,
} from '@happier-dev/protocol/reviews/comments/actions';

import { mapReviewCommentDraftAnchorToDurableV1Target } from '@/sync/domains/input/reviewComments/anchors/reviewCommentDraftAnchor';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function buildDurableReviewCommentCreateRequestFromDraft(params: Readonly<{
    draft: ReviewCommentDraft;
    clientMutationId: string;
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    engineId?: string;
    authorDeviceId?: string;
    clientLamport?: number;
} & Pick<ReviewCommentCreateRequestV1, 'reviewId' | 'roundOrdinal' | 'projectId' | 'workspace'>>): ReviewCommentCreateRequestV1 {
    const anchor = mapReviewCommentDraftAnchorToDurableV1Target({
        filePath: params.draft.filePath,
        anchor: params.draft.anchor,
    });
    if (!anchor) {
        throw new Error('Review comment draft cannot be promoted without a durable anchor target');
    }

    const allLines = [
        ...params.draft.snapshot.beforeContext,
        ...params.draft.snapshot.selectedLines,
        ...params.draft.snapshot.afterContext,
    ];

    return {
        reviewId: params.reviewId,
        roundOrdinal: params.roundOrdinal,
        projectId: params.projectId,
        workspace: params.workspace,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        engineId: params.engineId,
        anchor,
        snapshot: {
            kind: 'text',
            selectedLines: [...params.draft.snapshot.selectedLines],
            beforeContext: [...params.draft.snapshot.beforeContext],
            afterContext: [...params.draft.snapshot.afterContext],
            ...buildReviewCommentTextSnapshotHashes(params.draft.snapshot),
            capturedAt: params.draft.createdAt,
            fileLength: allLines.length,
            source: params.draft.source === 'diff' ? 'diffSide' : 'workingTree',
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: reviewCommentTextSnapshotHasBidiControlsV1(allLines),
            likelyMinified: reviewCommentTextSnapshotIsLikelyMinifiedV1(allLines),
        },
        body: params.draft.body,
        authorIntent: 'propose',
        clientMutationId: params.clientMutationId,
        authorDeviceId: params.authorDeviceId,
        clientLamport: params.clientLamport,
    };
}

export type SubmitDurableReviewCommentDraftParams = Readonly<{
    draft: ReviewCommentDraft;
    clientMutationId: string;
    actions: Readonly<{
        create: (input: ReviewCommentCreateRequestV1) => Promise<ReviewCommentCreateResponseV1>;
    }>;
    onPromoted?: (event: Readonly<{ draftId: string; commentId: string }>) => void;
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    engineId?: string;
    authorDeviceId?: string;
    clientLamport?: number;
} & Pick<ReviewCommentCreateRequestV1, 'reviewId' | 'roundOrdinal' | 'projectId' | 'workspace'>>;

export async function submitDurableReviewCommentDraft(
    params: SubmitDurableReviewCommentDraftParams,
): Promise<ReviewCommentCreateResponseV1> {
    const request = buildDurableReviewCommentCreateRequestFromDraft({
        reviewId: params.reviewId,
        roundOrdinal: params.roundOrdinal,
        projectId: params.projectId,
        workspace: params.workspace,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        engineId: params.engineId,
        draft: params.draft,
        clientMutationId: params.clientMutationId,
        authorDeviceId: params.authorDeviceId,
        clientLamport: params.clientLamport,
    });
    const response = await params.actions.create(request);
    params.onPromoted?.({
        draftId: params.draft.id,
        commentId: response.comment.id,
    });
    return response;
}
