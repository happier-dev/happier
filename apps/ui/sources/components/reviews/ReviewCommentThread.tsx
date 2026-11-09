import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

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

export function ReviewCommentThread(props: ReviewCommentThreadProps) {
    const replies = [...props.replies].sort((left, right) => left.createdAt - right.createdAt);
    // One Reply for the whole thread, on its root's action row.
    const { onReply } = props;
    const rootActions = React.useMemo(() => (onReply
        ? { ...props.cardActions, onReply: (comment: ReviewCommentV1) => onReply({ parentCommentId: comment.id }) }
        : props.cardActions), [onReply, props.cardActions]);
    return (
        <View testID={props.testID} style={styles.thread}>
            <ReviewCommentCard
                comment={props.root}
                labels={props.labels}
                actions={rootActions}
                testID={`review-comment-${props.root.id}`}
            />
            {replies.length > 0 ? (
                <View style={styles.replies}>
                    {replies.map((reply) => (
                        <ReviewCommentCard
                            key={reply.id}
                            comment={reply}
                            labels={props.labels}
                            actions={props.cardActions}
                            testID={`review-comment-${reply.id}`}
                        />
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    thread: { borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    replies: { marginLeft: theme.space.s16, borderLeftWidth: 1, borderLeftColor: theme.colors.border.default, paddingLeft: theme.space.s12 },
}));
