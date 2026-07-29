import React from 'react';
import { Pressable, View } from 'react-native';

import type { ReviewCommentStateV1, ReviewCommentV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';

import type { ReviewCommentLabels } from './labels';
import type { ReviewCommentCardActions } from './ReviewCommentCard';
import { ReviewCommentFilters } from './ReviewCommentFilters';
import { ReviewCommentsList } from './ReviewCommentsList';

export type ReviewCommentBulkTransitionInput = Readonly<{
    commentIds: readonly string[];
    toState: ReviewCommentStateV1;
}>;

export type ReviewCommentBulkTransitionResult = Readonly<{
    bulkActionId: string;
    failed: readonly Readonly<{
        commentId: string;
        errorCode: string;
    }>[];
}>;

export type ReviewCommentsPanelProps = Readonly<{
    comments: readonly ReviewCommentV1[];
    labels: ReviewCommentLabels & Readonly<{ filtersTitle: string }>;
    selectedStates?: readonly ReviewCommentStateV1[];
    stateOptions?: readonly ReviewCommentStateV1[];
    onToggleState?: (state: ReviewCommentStateV1) => void;
    cardActions?: ReviewCommentCardActions;
    onReply?: (input: Readonly<{ parentCommentId: string }>) => void;
    onBulkTransition?: (input: ReviewCommentBulkTransitionInput) => void;
    bulkTransitionResult?: ReviewCommentBulkTransitionResult | null;
    testID?: string;
}>;

export function ReviewCommentsPanel(props: ReviewCommentsPanelProps) {
    const stateOptions = props.stateOptions ?? ['proposed', 'open', 'delegated', 'pending_review', 'resolved', 'dismissed'];
    const commentIds = props.comments.map((comment) => comment.id);
    const canBulkTransition = props.onBulkTransition && commentIds.length > 0;
    return (
        <View testID={props.testID}>
            <ReviewCommentFilters
                labels={{ title: props.labels.filtersTitle, states: props.labels.states }}
                stateOptions={stateOptions}
                selectedStates={props.selectedStates ?? []}
                onToggleState={props.onToggleState}
                testID={props.testID ? `${props.testID}-filters` : undefined}
            />
            {canBulkTransition ? (
                <View>
                    <Pressable
                        accessibilityRole="button"
                        onPress={() => props.onBulkTransition?.({ commentIds, toState: 'resolved' })}
                        testID={props.testID ? `${props.testID}-bulk-resolve` : undefined}
                    >
                        <Text>{props.labels.bulkResolve}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        onPress={() => props.onBulkTransition?.({ commentIds, toState: 'dismissed' })}
                        testID={props.testID ? `${props.testID}-bulk-dismiss` : undefined}
                    >
                        <Text>{props.labels.bulkDismiss}</Text>
                    </Pressable>
                </View>
            ) : null}
            {props.bulkTransitionResult && props.bulkTransitionResult.failed.length > 0 ? (
                <View testID={props.testID ? `${props.testID}-bulk-failures` : undefined}>
                    <Text>{props.labels.bulkPartialFailure}</Text>
                    {props.bulkTransitionResult.failed.map((failure) => (
                        <Text key={`${failure.commentId}:${failure.errorCode}`}>
                            {props.labels.bulkFailure(failure)}
                        </Text>
                    ))}
                </View>
            ) : null}
            <ReviewCommentsList
                comments={props.comments}
                labels={props.labels}
                cardActions={props.cardActions}
                onReply={props.onReply}
                testID={props.testID ? `${props.testID}-list` : undefined}
            />
        </View>
    );
}
