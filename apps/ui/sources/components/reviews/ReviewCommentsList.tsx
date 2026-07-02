import React from 'react';
import { View } from 'react-native';

import type { ReviewCommentV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';

import { ReviewCommentThread } from './ReviewCommentThread';
import type { ReviewCommentCardActions } from './ReviewCommentCard';
import type { ReviewCommentLabels } from './labels';

export type ReviewCommentsListProps = Readonly<{
    comments: readonly ReviewCommentV1[];
    labels: ReviewCommentLabels;
    directWriteGranted: boolean;
    cardActions?: ReviewCommentCardActions;
    onReply?: (input: Readonly<{ parentCommentId: string }>) => void;
    testID?: string;
}>;

function groupRootComments(comments: readonly ReviewCommentV1[]): readonly Readonly<{
    root: ReviewCommentV1;
    replies: readonly ReviewCommentV1[];
}>[] {
    const byThreadId = new Map<string, ReviewCommentV1[]>();
    for (const comment of comments) {
        const group = byThreadId.get(comment.threadId) ?? [];
        group.push(comment);
        byThreadId.set(comment.threadId, group);
    }

    return [...byThreadId.values()].map((threadComments) => {
        const root = threadComments.find((comment) => !comment.parentCommentId)
            ?? threadComments[0] as ReviewCommentV1;
        return {
            root,
            replies: threadComments.filter((comment) => comment.id !== root.id),
        };
    });
}

export function ReviewCommentsList(props: ReviewCommentsListProps) {
    const directWriteLabel = props.directWriteGranted
        ? props.labels.directWriteGranted
        : props.labels.directWriteMissing;

    if (props.comments.length === 0) {
        return (
            <View testID={props.testID}>
                <Text>{directWriteLabel}</Text>
                <Text>{props.labels.empty}</Text>
            </View>
        );
    }

    return (
        <View testID={props.testID}>
            <Text>{directWriteLabel}</Text>
            {groupRootComments(props.comments).map(({ root, replies }) => (
                <ReviewCommentThread
                    key={root.id}
                    root={root}
                    replies={replies}
                    labels={props.labels}
                    cardActions={props.cardActions}
                    onReply={props.onReply}
                    testID={`review-comment-${root.id}`}
                />
            ))}
        </View>
    );
}
