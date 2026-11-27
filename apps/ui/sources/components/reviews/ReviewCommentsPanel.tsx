import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ReviewCommentStateV1Schema, type ReviewCommentStateV1, type ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { reviewCommentTransitionAllowedV1 } from '@happier-dev/protocol/reviews/comments/mutation';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
    serverId?: string;
    labels: ReviewCommentLabels & Readonly<{ filtersTitle: string }>;
    selectedStates?: readonly ReviewCommentStateV1[];
    stateOptions?: readonly ReviewCommentStateV1[];
    onToggleState?: (state: ReviewCommentStateV1) => void;
    cardActions?: ReviewCommentCardActions;
    onReply?: (input: Readonly<{ parentCommentId: string }>) => void;
    onBulkTransition?: (input: ReviewCommentBulkTransitionInput) => void;
    bulkTransitionResult?: ReviewCommentBulkTransitionResult | null;
    listFooter?: React.ReactElement | null;
    testID?: string;
}>;

export function ReviewCommentsPanel(props: ReviewCommentsPanelProps) {
    const stateOptions = props.stateOptions ?? ReviewCommentStateV1Schema.options;
    const eligibleIds = (toState: ReviewCommentStateV1) => props.comments
        .filter((comment) => !comment.flags.redacted && !comment.tombstone
            && !(comment.reviewId && comment.finding)
            && reviewCommentTransitionAllowedV1(comment.state, toState))
        .map((comment) => comment.id);
    const resolvableIds = eligibleIds('resolved');
    const dismissibleIds = eligibleIds('dismissed');
    const canBulkTransition = props.onBulkTransition && (resolvableIds.length > 0 || dismissibleIds.length > 0);
    return (
        <View testID={props.testID} style={styles.panel}>
            {/* One quiet toolbar: the state filters lead, the bulk links for what they show trail. */}
            <View style={styles.toolbar}>
                <View style={styles.filters}>
                    <ReviewCommentFilters
                        labels={{ title: props.labels.filtersTitle, states: props.labels.states }}
                        stateOptions={stateOptions}
                        selectedStates={props.selectedStates ?? []}
                        onToggleState={props.onToggleState}
                        testID={props.testID ? `${props.testID}-filters` : undefined}
                    />
                </View>
                {canBulkTransition ? (
                    <View style={styles.bulk}>
                        {resolvableIds.length > 0 ? <TextLinkButton
                            label={props.labels.bulkResolve}
                            size="meta"
                            onPress={() => props.onBulkTransition?.({ commentIds: resolvableIds, toState: 'resolved' })}
                            testID={props.testID ? `${props.testID}-bulk-resolve` : undefined}
                        /> : null}
                        {dismissibleIds.length > 0 ? <TextLinkButton
                            label={props.labels.bulkDismiss}
                            size="meta"
                            onPress={() => props.onBulkTransition?.({ commentIds: dismissibleIds, toState: 'dismissed' })}
                            testID={props.testID ? `${props.testID}-bulk-dismiss` : undefined}
                        /> : null}
                    </View>
                ) : null}
            </View>
            {props.bulkTransitionResult && props.bulkTransitionResult.failed.length > 0 ? (
                <View testID={props.testID ? `${props.testID}-bulk-failures` : undefined} style={styles.failures}>
                    <SurfaceStateCard size="line" kind="warning" title={props.labels.bulkPartialFailure} />
                    {props.bulkTransitionResult.failed.map((failure) => (
                        <Text key={`${failure.commentId}:${failure.errorCode}`} variant="meta" style={styles.failure}>
                            {props.labels.bulkFailure(failure)}
                        </Text>
                    ))}
                </View>
            ) : null}
            {/* The toolbar stays put; only the comments scroll within the room the host gives them. */}
            <ReviewCommentsList
                comments={props.comments}
                serverId={props.serverId}
                labels={props.labels}
                cardActions={props.cardActions}
                onReply={props.onReply}
                listFooter={props.listFooter}
                testID={props.testID ? `${props.testID}-list` : undefined}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    panel: { gap: theme.space.s8, flex: 1, minHeight: 0 },
    toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: theme.space.s16, rowGap: theme.space.s6 },
    filters: { flexShrink: 1, minWidth: 0 },
    bulk: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space.s16 },
    failures: { gap: theme.space.s4 },
    failure: { color: theme.colors.text.secondary },
}));
