import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewFollowUpV1 } from '@happier-dev/protocol';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Text } from '@/components/ui/text/Text';

export function ReviewFollowUpMessageCard(props: Readonly<{ payload: ReviewFollowUpV1 }>) {
    return (
        <View style={styles.container}>
            <MarkdownView markdown={props.payload.requestMarkdown} textStyle={styles.markdownText} />
            <MarkdownView markdown={props.payload.answerMarkdown} textStyle={styles.markdownText} />
            {props.payload.updatedFindings?.length ? (
                <View style={styles.findingsBlock}>
                    {props.payload.updatedFindings.map((finding) => (
                        <View key={finding.id} style={styles.findingRow}>
                            <Text style={styles.findingTitle}>{finding.title}</Text>
                            <Text style={styles.findingSummary}>{finding.summary}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
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
    markdownText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    findingsBlock: {
        gap: 8,
    },
    findingRow: {
        gap: 2,
    },
    findingTitle: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    findingSummary: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));
