import React from 'react';

import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import type { ReviewCommentLabels } from './labels';
import { ReviewCommentsList } from './ReviewCommentsList';
import type { ReviewCommentCardActions } from './ReviewCommentCard';

const HISTORY_STATES = new Set(['resolved', 'dismissed'] as const);

function isHistoryComment(comment: ReviewCommentV1): boolean {
    return HISTORY_STATES.has(comment.state as 'resolved' | 'dismissed') || comment.flags.redacted === true || Boolean(comment.tombstone);
}

export type ReviewCommentsHistoryViewProps = Readonly<{
    comments: readonly ReviewCommentV1[];
    serverId?: string;
    labels: ReviewCommentLabels;
    cardActions?: ReviewCommentCardActions;
    listFooter?: React.ReactElement | null;
    testID?: string;
}>;

export function ReviewCommentsHistoryView(props: ReviewCommentsHistoryViewProps) {
    return (
        <ReviewCommentsList
            comments={props.comments.filter(isHistoryComment)}
            serverId={props.serverId}
            labels={props.labels}
            cardActions={props.cardActions}
            listFooter={props.listFooter}
            testID={props.testID}
        />
    );
}
