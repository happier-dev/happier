import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewCommentsV1 } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatReviewCommentAnchorLabel } from '@/sync/domains/input/reviewComments/reviewCommentPresentation';
import { t } from '@/text';


export function ReviewCommentsMessageCard(props: {
    payload: ReviewCommentsV1;
    onJumpToAnchor?: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}) {
    const comments = props.payload.comments;
    const byFile = React.useMemo(() => {
        const map = new Map<string, typeof comments>();
        for (const c of comments) {
            const existing = map.get(c.filePath);
            if (existing) existing.push(c);
            else map.set(c.filePath, [c]);
        }
        return map;
    }, [comments]);

    return (
        <View style={styles.container}>
            <Text selectable style={styles.headerText}>{t('files.reviewComments.title', { count: comments.length })}</Text>
            {[...byFile.entries()].map(([filePath, fileComments]) => (
                <View key={filePath} style={styles.fileGroup}>
                    <Text selectable style={styles.filePathText}>{filePath}</Text>
                    {fileComments.map((c) => {
                        return (
                            <View key={c.id} style={styles.commentRow}>
                                <View
                                    testID={`review-comments-header:${c.id}`}
                                    style={styles.commentHeader}
                                >
                                    <Text selectable numberOfLines={1} style={styles.anchorText}>
                                        {formatReviewCommentAnchorLabel(c)}
                                    </Text>
                                    {props.onJumpToAnchor ? (
                                        <Pressable
                                            testID={`review-comments-jump:${c.id}`}
                                            accessibilityRole="button"
                                            onPress={() => props.onJumpToAnchor?.({ filePath: c.filePath, source: c.source, anchor: c.anchor })}
                                            style={styles.jumpButton}
                                        >
                                            <Text style={styles.jumpText}>{t('files.reviewComments.jump')}</Text>
                                        </Pressable>
                                    ) : null}
                                </View>
                                <View style={styles.commentBody}>
                                    {c.snapshot.beforeContext.map((line, idx) => (
                                        <Text selectable key={`before:${idx}`} numberOfLines={1} style={styles.codeMutedText}>{line}</Text>
                                    ))}
                                    {c.snapshot.selectedLines.map((line, idx) => (
                                        <Text selectable key={`selected:${idx}`} numberOfLines={1} style={styles.codeText}>{line}</Text>
                                    ))}
                                    <Text selectable style={styles.commentText}>{c.body}</Text>
                                    {c.snapshot.afterContext.map((line, idx) => (
                                        <Text selectable key={`after:${idx}`} numberOfLines={1} style={styles.codeMutedText}>{line}</Text>
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
