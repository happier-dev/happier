import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewCommentsV1 } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { Typography } from '@/constants/Typography';
import { formatReviewCommentAnchorLabel } from '@/sync/domains/input/reviewComments/reviewCommentPresentation';
import { t } from '@/text';
import { StructuredFindText, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';

function reviewCommentsDisplay(payload: ReviewCommentsV1, canJumpToAnchor: boolean) {
    const files = new Map<string, ReviewCommentsV1['comments']>();
    for (const comment of payload.comments) {
        const comments = files.get(comment.filePath);
        if (comments) comments.push(comment);
        else files.set(comment.filePath, [comment]);
    }
    const block = (id: string, text: string): StructuredFindTextBlock => ({ id, text });
    return {
        header: block('structured-review-comments:header', t('files.reviewComments.title', { count: payload.comments.length })),
        groups: [...files].map(([filePath, comments]) => ({
            file: block(`structured-review-comments:file:${filePath}`, filePath),
            comments: comments.map((comment) => {
                const prefix = `structured-review-comment:${comment.id}`;
                return {
                    comment,
                    anchor: block(`${prefix}:anchor`, formatReviewCommentAnchorLabel(comment)),
                    jump: canJumpToAnchor ? block(`${prefix}:jump`, t('files.reviewComments.jump')) : null,
                    before: comment.snapshot.beforeContext.map((text, index) => block(`${prefix}:before:${index}`, text)),
                    selected: comment.snapshot.selectedLines.map((text, index) => block(`${prefix}:selected:${index}`, text)),
                    body: block(`${prefix}:body`, comment.body),
                    after: comment.snapshot.afterContext.map((text, index) => block(`${prefix}:after:${index}`, text)),
                };
            }),
        })),
    };
}

export function projectReviewCommentsFindText(payload: ReviewCommentsV1, options?: Readonly<{ canJumpToAnchor?: boolean }>): readonly StructuredFindTextBlock[] {
    const display = reviewCommentsDisplay(payload, options?.canJumpToAnchor === true);
    return [display.header, ...display.groups.flatMap((group) => [group.file, ...group.comments.flatMap((comment) => [
        comment.anchor, ...comment.before, ...comment.selected, comment.body, ...comment.after,
    ])])];
}

export function ReviewCommentsMessageCard(props: {
    payload: ReviewCommentsV1;
    onJumpToAnchor?: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}) {
    const display = React.useMemo(() => reviewCommentsDisplay(props.payload, Boolean(props.onJumpToAnchor)), [props.payload, props.onJumpToAnchor]);

    return (
        <View style={styles.container}>
            <StructuredFindText blockId={display.header.id} text={display.header.text} selectable style={styles.headerText} />
            {display.groups.map((group) => (
                <View key={group.file.text} style={styles.fileGroup}>
                    <StructuredFindText blockId={group.file.id} text={group.file.text} selectable style={styles.filePathText} />
                    {group.comments.map((item) => {
                        const c = item.comment;
                        return (
                            <View key={c.id} style={styles.commentRow}>
                                <View
                                    testID={`review-comments-header:${c.id}`}
                                    style={styles.commentHeader}
                                >
                                    <StructuredFindText blockId={item.anchor.id} text={item.anchor.text} selectable numberOfLines={1} style={styles.anchorText} />
                                    {props.onJumpToAnchor ? (
                                        <Pressable
                                            testID={`review-comments-jump:${c.id}`}
                                            accessibilityRole="button"
                                            onPress={() => props.onJumpToAnchor?.({ filePath: c.filePath, source: c.source, anchor: c.anchor })}
                                            style={styles.jumpButton}
                                        >
                                            {item.jump ? <StructuredFindText blockId={item.jump.id} text={item.jump.text} style={styles.jumpText} /> : null}
                                        </Pressable>
                                    ) : null}
                                </View>
                                <View style={styles.commentBody}>
                                    {item.before.map((line) => (
                                        <StructuredFindText blockId={line.id} text={line.text} selectable key={line.id} numberOfLines={1} style={styles.codeMutedText} />
                                    ))}
                                    {item.selected.map((line) => (
                                        <StructuredFindText blockId={line.id} text={line.text} selectable key={line.id} numberOfLines={1} style={styles.codeText} />
                                    ))}
                                    <StructuredFindText blockId={item.body.id} text={item.body.text} selectable style={styles.commentText} />
                                    {item.after.map((line) => (
                                        <StructuredFindText blockId={line.id} text={line.text} selectable key={line.id} numberOfLines={1} style={styles.codeMutedText} />
                                    ))}
                                </View>
                            </View>
                        );
                    })}
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 10,
    },
    headerText: {
        color: theme.colors.text.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    fileGroup: {
        gap: 8,
    },
    filePathText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        fontWeight: '600',
    },
    commentRow: {
        gap: 6,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    commentHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    anchorText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default(),
    },
    jumpButton: {
        paddingHorizontal: 6,
        paddingVertical: 3,
    },
    jumpText: {
        color: theme.colors.text.link,
        fontSize: 12,
        fontWeight: '600',
    },
    commentBody: {
        gap: 4,
        padding: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.elevated,
    },
    codeText: {
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
        fontSize: 12,
    },
    codeMutedText: {
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
        fontSize: 12,
    },
    commentText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.elevated,
        ...Typography.default(),
    },
}));
