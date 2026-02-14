import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewCommentsV1 } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function ReviewCommentsMessageCard(props: {
    payload: ReviewCommentsV1;
    onJumpToAnchor: (target: { filePath: string; source: ReviewCommentSource; anchor: ReviewCommentAnchor }) => void;
}) {
    const [expandedCommentId, setExpandedCommentId] = React.useState<string | null>(null);

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
            <Text style={styles.headerText}>Review comments ({comments.length})</Text>
            {[...byFile.entries()].map(([filePath, fileComments]) => (
                <View key={filePath} style={styles.fileGroup}>
                    <Text style={styles.filePathText}>{filePath}</Text>
                    {fileComments.map((c) => {
                        const isExpanded = expandedCommentId === c.id;
                        return (
                            <View key={c.id} style={styles.commentRow}>
                                <Pressable
                                    onPress={() => setExpandedCommentId((prev) => (prev === c.id ? null : c.id))}
                                    style={styles.commentHeader}
                                >
                                    <Text style={styles.commentHeaderText}>{c.body}</Text>
                                </Pressable>
                                <View style={styles.commentActions}>
                                    <Pressable onPress={() => props.onJumpToAnchor({ filePath: c.filePath, source: c.source, anchor: c.anchor })}>
                                        <Text style={styles.jumpText}>Jump</Text>
                                    </Pressable>
                                </View>
                                {isExpanded && (
                                    <View style={styles.commentBody}>
                                        {c.snapshot.selectedLines.map((line, idx) => (
                                            <Text key={idx} style={styles.codeText}>{line}</Text>
                                        ))}
                                    </View>
                                )}
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
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
    },
    headerText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '600',
    },
    fileGroup: {
        gap: 6,
    },
    filePathText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    commentRow: {
        paddingVertical: 6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    commentHeader: {
        paddingVertical: 4,
    },
    commentHeaderText: {
        color: theme.colors.text,
        fontSize: 13,
    },
    commentActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingTop: 2,
    },
    jumpText: {
        color: theme.colors.textLink,
        fontSize: 12,
        fontWeight: '600',
    },
    commentBody: {
        paddingTop: 6,
        gap: 2,
    },
    codeText: {
        color: theme.colors.text,
        fontFamily: 'Menlo',
        fontSize: 12,
    },
}));
