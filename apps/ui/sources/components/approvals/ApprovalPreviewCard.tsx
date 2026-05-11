import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

function getPreviewSummary(preview: unknown): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const summary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    return summary || null;
}

export const ApprovalPreviewCard = React.memo(function ApprovalPreviewCard(props: Readonly<{ preview: unknown }>) {
    const summary = React.useMemo(() => getPreviewSummary(props.preview), [props.preview]);
    if (!summary) return null;

    return (
        <View style={styles.card}>
            <Text style={styles.summary}>{summary}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        padding: 16,
        gap: 4,
    },
    summary: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
    },
}));
