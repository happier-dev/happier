import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import type { ReviewCommentLabels } from './labels';
import { ReviewCommentCard, type ReviewCommentCardActions } from './ReviewCommentCard';

export type ReviewCommentThreadRowProps = Readonly<{
    comment: ReviewCommentV1;
    isReply: boolean;
    isThreadEnd: boolean;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    labels: ReviewCommentLabels;
    cardActions?: ReviewCommentCardActions;
    onReply?: (input: Readonly<{ parentCommentId: string }>) => void;
    testID?: string;
}>;

export function ReviewCommentThreadRow(props: ReviewCommentThreadRowProps) {
    // One Reply for the whole thread, on its root's action row.
    const { onReply } = props;
    const rootActions = React.useMemo(() => (onReply && !props.isReply
        ? { ...props.cardActions, onReply: (comment: ReviewCommentV1) => onReply({ parentCommentId: comment.id }) }
        : props.cardActions), [onReply, props.cardActions, props.isReply]);
    return (
        <View testID={props.testID} style={props.isThreadEnd ? styles.thread : undefined}>
            <View style={props.isReply ? styles.replies : undefined}>
                <ReviewCommentCard
                    comment={props.comment}
                    labels={props.labels}
                    actions={rootActions}
                    expanded={props.expanded}
                    onExpandedChange={props.onExpandedChange}
                    testID={`review-comment-${props.comment.id}`}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    thread: { borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    replies: { marginLeft: theme.space.s16, borderLeftWidth: 1, borderLeftColor: theme.colors.border.default, paddingLeft: theme.space.s12 },
}));
