import React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';

import { ReviewCommentThreadRow } from './ReviewCommentThread';
import type { ReviewCommentCardActions } from './ReviewCommentCard';
import type { ReviewCommentLabels } from './labels';

export type ReviewCommentsListProps = Readonly<{
    comments: readonly ReviewCommentV1[];
    labels: ReviewCommentLabels;
    cardActions?: ReviewCommentCardActions;
    onReply?: (input: Readonly<{ parentCommentId: string }>) => void;
    listFooter?: React.ReactElement | null;
    testID?: string;
}>;

type CommentRow = Readonly<{ comment: ReviewCommentV1; isReply: boolean; isThreadEnd: boolean }>;

function groupCommentRows(comments: readonly ReviewCommentV1[]): readonly CommentRow[] {
    const byThreadId = new Map<string, ReviewCommentV1[]>();
    for (const comment of comments) {
        const group = byThreadId.get(comment.threadId) ?? [];
        group.push(comment);
        byThreadId.set(comment.threadId, group);
    }

    return [...byThreadId.values()].flatMap((threadComments) => {
        const root = threadComments.find((comment) => !comment.parentCommentId)
            ?? threadComments[0] as ReviewCommentV1;
        const replies = threadComments.filter((comment) => comment.id !== root.id)
            .sort((left, right) => left.createdAt - right.createdAt);
        return [root, ...replies].map((comment, index) => ({
            comment,
            isReply: index > 0,
            isThreadEnd: index === replies.length,
        }));
    });
}

export function ReviewCommentsList(props: ReviewCommentsListProps) {
    // A card can leave the viewport while its reader still has its detail expanded.
    const [expandedCommentIds, setExpandedCommentIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const setCommentExpanded = React.useCallback((commentId: string, expanded: boolean) => {
        setExpandedCommentIds((current) => {
            const next = new Set(current);
            if (expanded) next.add(commentId);
            else next.delete(commentId);
            return next;
        });
    }, []);
    const rows = React.useMemo(() => groupCommentRows(props.comments), [props.comments]);
    const rowInputs = React.useMemo(() => ({
        labels: props.labels,
        cardActions: props.cardActions,
        onReply: props.onReply,
        expandedCommentIds,
    }), [props.labels, props.cardActions, props.onReply, expandedCommentIds]);
    return (
        <VirtualizedList
            testID={props.testID}
            style={styles.list}
            data={rows}
            extraData={rowInputs}
            keyExtractor={(row) => row.comment.id}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<SurfaceStateCard size="line" kind="empty" title={props.labels.empty} />}
            ListFooterComponent={props.listFooter}
            renderItem={({ item }) => (
                <ReviewCommentThreadRow
                    {...item}
                    expanded={expandedCommentIds.has(item.comment.id)}
                    onExpandedChange={(expanded) => setCommentExpanded(item.comment.id, expanded)}
                    labels={props.labels}
                    cardActions={props.cardActions}
                    onReply={props.onReply}
                    testID={`review-comment-row-${item.comment.id}`}
                />
            )}
        />
    );
}

const styles = StyleSheet.create({ list: { flex: 1, minHeight: 0 } });
