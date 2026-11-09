import { Typography } from '@/constants/Typography';
import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewFollowUpV1 } from '@happier-dev/protocol/messages/structured/reviewFollowUpV1';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { StructuredFindText, useStructuredFindState, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';

function reviewFollowUpDisplay(payload: ReviewFollowUpV1) {
    return {
        request: { id: 'structured-review-follow-up:request', text: payload.requestMarkdown, format: 'markdown' as const },
        answer: { id: 'structured-review-follow-up:answer', text: payload.answerMarkdown, format: 'markdown' as const },
        findings: (payload.updatedFindings ?? []).map((finding) => ({
            id: finding.id,
            title: { id: `structured-review-follow-up:updated:${finding.id}:title`, text: finding.title },
            summary: { id: `structured-review-follow-up:updated:${finding.id}:summary`, text: finding.summary },
        })),
    };
}

export function projectReviewFollowUpFindText(payload: ReviewFollowUpV1): readonly StructuredFindTextBlock[] {
    const display = reviewFollowUpDisplay(payload);
    return [display.request, display.answer, ...display.findings.flatMap((finding) => [finding.title, finding.summary])];
}

export function ReviewFollowUpMessageCard(props: Readonly<{ payload: ReviewFollowUpV1 }>) {
    const display = reviewFollowUpDisplay(props.payload);
    const find = useStructuredFindState();
    return (
        <View style={styles.container}>
            <MarkdownView markdown={display.request.text} textStyle={styles.markdownText} findSourceRanges={find.ranges(display.request.id)} findActive={find.findActive} />
            <MarkdownView markdown={display.answer.text} textStyle={styles.markdownText} agentTexMath findSourceRanges={find.ranges(display.answer.id)} findActive={find.findActive} />
            {display.findings.length ? (
                <View style={styles.findingsBlock}>
                    {display.findings.map((finding) => (
                        <View key={finding.id} style={styles.findingRow}>
                            <StructuredFindText blockId={finding.title.id} text={finding.title.text} style={styles.findingTitle} />
                            <StructuredFindText blockId={finding.summary.id} text={finding.summary.text} style={styles.findingSummary} />
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: theme.space.s12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: theme.space.s10,
    },
    markdownText: {
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    findingsBlock: {
        gap: theme.space.s8,
    },
    findingRow: {
        gap: theme.space.s2,
    },
    findingTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
    },
    findingSummary: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));
