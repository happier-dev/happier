import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { readApprovalPreviewSummary, type ApprovalSummaryInput } from './actionApprovalPresentation';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';


export const ApprovalPreviewCard = React.memo(function ApprovalPreviewCard(props: Readonly<{ preview: unknown; request?: ApprovalSummaryInput }>) {
    const language = usePreferredLanguage();
    const summary = React.useMemo(() => readApprovalPreviewSummary(props.preview, props.request), [props.preview, props.request, language]);
    if (!summary) return null;

    return (
        <View style={styles.card}>
            <Text style={styles.summary}>{summary}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the approval's "Request" section: the section owns the chrome.
    card: {
        gap: theme.space.s4,
    },
    summary: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
    },
}));
