import React from 'react';

import type { ReviewCommentV1 } from '@happier-dev/protocol';

import type { ReviewCommentLabels } from './labels';
import { ReviewCommentsList } from './ReviewCommentsList';

const HISTORY_STATES = new Set(['resolved', 'dismissed'] as const);

function isHistoryComment(comment: ReviewCommentV1): boolean {
    return HISTORY_STATES.has(comment.state as 'resolved' | 'dismissed') || comment.flags.redacted === true || Boolean(comment.tombstone);
}

export type ReviewCommentsHistoryViewProps = Readonly<{
    comments: readonly ReviewCommentV1[];
    labels: ReviewCommentLabels;
    directWriteGranted: boolean;
    testID?: string;
}>;

export function ReviewCommentsHistoryView(props: ReviewCommentsHistoryViewProps) {
    return (
        <ReviewCommentsList
            comments={props.comments.filter(isHistoryComment)}
            labels={props.labels}
            directWriteGranted={props.directWriteGranted}
            testID={props.testID}
        />
    );
}
