import React from 'react';
import { Pressable, View } from 'react-native';

import type { ReviewCommentV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';

import type { ReviewCommentLabels } from './labels';
import { ReviewCommentCard, type ReviewCommentCardActions } from './ReviewCommentCard';

export type ReviewCommentThreadProps = Readonly<{
    root: ReviewCommentV1;
    replies: readonly ReviewCommentV1[];
    labels: ReviewCommentLabels;
    cardActions?: ReviewCommentCardActions;
    onReply?: (input: Readonly<{ parentCommentId: string }>) => void;
    testID?: string;
}>;

function isReplyDisabled(comment: ReviewCommentV1): boolean {
    return comment.state === 'resolved'
        || comment.state === 'dismissed'
        || comment.flags.redacted === true
        || Boolean(comment.tombstone);
}

export function ReviewCommentThread(props: ReviewCommentThreadProps) {
    const replies = [...props.replies].sort((left, right) => left.createdAt - right.createdAt);
    const replyDisabled = isReplyDisabled(props.root);
    return (
        <View testID={props.testID}>
            <ReviewCommentCard
                comment={props.root}
                labels={props.labels}
                actions={props.cardActions}
                testID={`review-comment-${props.root.id}`}
            />
            {replies.map((reply) => (
                <ReviewCommentCard
                    key={reply.id}
                    comment={reply}
                    labels={props.labels}
                    actions={props.cardActions}
                    testID={`review-comment-${reply.id}`}
                />
            ))}
            {props.onReply && replyDisabled ? (
                <View
                    accessibilityRole="button"
                    accessibilityState={{ disabled: true }}
                    testID={props.testID ? `${props.testID}-reply` : `review-comment-${props.root.id}-reply`}
                >
                    <Text>{props.labels.replyUnavailable}</Text>
                </View>
            ) : props.onReply ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: false }}
                    onPress={() => props.onReply?.({ parentCommentId: props.root.id })}
                    testID={props.testID ? `${props.testID}-reply` : `review-comment-${props.root.id}-reply`}
                >
                    <Text>{props.labels.reply}</Text>
                </Pressable>
            ) : null}
        </View>
    );
}
