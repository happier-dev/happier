import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StructuredFindText, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';

type SubagentCardProps = Readonly<{
    title: string;
    targetLabel: string;
    messageText: string;
    detailText?: string | null;
}>;

export function projectSubagentStructuredFindText(props: SubagentCardProps): readonly StructuredFindTextBlock[] {
    return [
        { id: 'structured-subagent-title', text: props.title },
        { id: 'structured-subagent-target', text: props.targetLabel },
        ...(props.detailText ? [{ id: 'structured-subagent-detail', text: props.detailText }] : []),
        { id: 'structured-subagent-body', text: props.messageText },
    ];
}

export function SubagentStructuredMessageCard(props: SubagentCardProps) {
    const blocks = projectSubagentStructuredFindText(props);
    return (
        <View style={styles.container}>
            {blocks.map((block) => <StructuredFindText key={block.id} selectable blockId={block.id} text={block.text}
                style={block.id === 'structured-subagent-title' ? styles.headerText : block.id === 'structured-subagent-target' ? styles.targetText : block.id === 'structured-subagent-detail' ? styles.detailText : styles.bodyText} />)}
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
        gap: 8,
    },
    headerText: {
        color: theme.colors.text.primary,
        fontSize: 14,
        fontWeight: '600',
    },
    targetText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '600',
    },
    detailText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    bodyText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
}));
