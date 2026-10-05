import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { ReviewFindingThreadEntry } from '@/components/sessions/reviews/messages/resolveEffectiveReviewFindings';
import {
    ReviewFollowUpComposer,
    type ReviewFollowUpRecipient,
} from '@/components/sessions/reviews/findings/ReviewFollowUpComposer';
import { formatReviewFindingThreadQuote, formatReviewFindingThreadUpdate, reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { useStructuredFindState, StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';

/** One question about a finding with the answer of the reviewer it went to. */
export type ReviewFindingThreadEntryView = ReviewFindingThreadEntry & Readonly<{ reviewerLabel: string }>;

/** Where a finding's questions are composed and who they go to. */
export type ReviewFindingAskContext = Readonly<{
    sessionId: string;
    serverId: string | null;
    draftRunId: string;
    recipient: ReviewFollowUpRecipient;
    /** "Waiting for Sonnet 5…" while a sent question has no answer yet. */
    waitingLabel: string;
}>;

/**
 * The thread under one finding (Ask about this, lab R3): the finding quoted, each question with the
 * reviewer's answer and what the answer changed, then the one composer for the next question.
 */
export function ReviewFindingThread(props: Readonly<{
    rowId: string;
    finding: ReviewFinding;
    entries: readonly ReviewFindingThreadEntryView[];
    /** A question sent whose answer has not arrived yet. */
    pendingQuestion: string | null;
    askContext: ReviewFindingAskContext;
    onAsk: (messageMarkdown: string) => Promise<boolean>;
    findBlockPrefix?: string;
}>) {
    const { theme } = useUnistyles();
    const find = useStructuredFindState();
    const quote = formatReviewFindingThreadQuote(props.finding);
    const severity = reviewSeverityLabel(props.finding.severity);
    const quoteRanges = find.ranges(`${props.findBlockPrefix}:quote`);
    return (
        <View testID={`review-finding-thread:${props.rowId}`} style={styles.thread}>
            <View style={styles.quote}>
                <Text style={styles.quoteText}>
                    <Text style={styles.quoteStrong}><FindHighlightedText text={severity} ranges={sliceFindRanges(quoteRanges, 0, severity.length)} /></Text>
                    <FindHighlightedText text={quote.slice(severity.length)} ranges={sliceFindRanges(quoteRanges, severity.length, quote.length - severity.length)} />
                </Text>
            </View>
            {props.entries.map((entry, index) => (
                <View key={`${entry.threadId}:${entry.generatedAtMs}:${index}`} style={styles.entry}>
                    <View style={styles.question}>
                        <MarkdownView markdown={entry.requestMarkdown} textStyle={styles.questionText} findSourceRanges={find.ranges(`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:request`)} findActive={find.findActive} />
                    </View>
                    <View style={styles.answer}>
                        <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:reviewer`} text={entry.reviewerLabel} style={styles.answerAuthor} />
                        <MarkdownView markdown={entry.answerMarkdown} textStyle={styles.answerText} agentTexMath findSourceRanges={find.ranges(`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:answer`)} findActive={find.findActive} />
                    </View>
                    {entry.updatedFinding && entry.previousFinding ? (
                        <View style={styles.change}>
                            <Icon name="arrows-clockwise" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                            <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:updated`} text={formatReviewFindingThreadUpdate(entry.reviewerLabel, entry.previousFinding, entry.updatedFinding)} style={styles.changeText} />
                        </View>
                    ) : null}
                </View>
            ))}
            {props.pendingQuestion ? (
                <View style={styles.entry}>
                    <View style={styles.question}>
                        <Text style={styles.questionText}>{props.pendingQuestion}</Text>
                    </View>
                    <Text style={styles.waiting}>{props.askContext.waitingLabel}</Text>
                </View>
            ) : null}
            <ReviewFollowUpComposer
                testID={`review-finding-ask-field:${props.rowId}`}
                sessionId={props.askContext.sessionId}
                serverId={props.askContext.serverId}
                draftRunId={props.askContext.draftRunId}
                placeholder={t('runPage.review.askPlaceholder')}
                recipient={props.askContext.recipient}
                onSend={props.onAsk}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    thread: {
        gap: 12,
        marginTop: 6,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    quote: {
        paddingLeft: 12,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border.default,
    },
    quoteText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    quoteStrong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    entry: {
        gap: 8,
    },
    question: {
        alignSelf: 'flex-end',
        maxWidth: '88%',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 14,
        backgroundColor: theme.colors.surface.inset,
    },
    questionText: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 20,
    },
    answer: {
        gap: 2,
    },
    answerAuthor: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    answerText: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 20,
    },
    change: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    changeText: {
        ...Typography.default(),
        flexShrink: 1,
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    waiting: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
}));
