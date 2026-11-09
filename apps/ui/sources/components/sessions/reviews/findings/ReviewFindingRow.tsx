import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, usePreferredLanguage } from '@/text';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import {
    ReviewFindingThread,
    type ReviewFindingAskContext,
    type ReviewFindingThreadEntryView,
} from '@/components/sessions/reviews/findings/ReviewFindingThread';
import type { ReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { formatReviewFindingLocation, reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { REVIEW_SEVERITY_COLUMN_WIDTH_PX, ReviewSeverityLabel } from '@/components/sessions/reviews/findings/ReviewSeverity';
import { StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';

export type ReviewFindingDecision = 'accept' | 'reject' | 'defer';
export const REVIEW_FINDING_DECISIONS: readonly ReviewFindingDecision[] = ['accept', 'reject', 'defer'];

/**
 * How much of a finding a presentation shows (lab R2): `page` is the result page (description
 * shown, one per row); `card` is the transcript card (title and place only).
 */
export type ReviewFindingRowDensity = 'page' | 'card';

function decisionLabel(decision: ReviewFindingDecision): string {
    switch (decision) {
        case 'accept': return t('session.reviewFindings.status.accept');
        case 'reject': return t('session.reviewFindings.status.reject');
        case 'defer': return t('session.reviewFindings.status.defer');
    }
}

/** Accept · Defer · Reject: the one triage control wherever a finding is decided (transcript, Run page, walkthrough). */
export const ReviewFindingDecisionControl = React.memo(function ReviewFindingDecisionControl(props: Readonly<{
    testIDPrefix: string;
    decision: ReviewFindingDecision | 'undecided';
    disabled: boolean;
    onDecide: (decision: ReviewFindingDecision) => void;
}>) {
    const language = usePreferredLanguage();
    const tabs = React.useMemo(() => REVIEW_FINDING_DECISIONS.map((decision) => ({ id: decision, label: decisionLabel(decision) })), [language]);
    return (
        <SegmentedTabBar<ReviewFindingDecision>
            role="radiogroup"
            tabs={tabs}
            activeTabId={props.decision as ReviewFindingDecision}
            onSelectTab={props.onDecide}
            disabled={props.disabled}
            compact
            segmentSizing="content"
            accessibilityLabel={t('runPage.review.triageLabel')}
            testIDPrefix={props.testIDPrefix}
        />
    );
});

/** One finding: severity, what and where, what changed after a question, your decision, its thread. */
export const ReviewFindingRow = React.memo(function ReviewFindingRow(props: Readonly<{
    /** The row's id within its review: what its controls and callbacks are keyed by. */
    rowId: string;
    finding: ReviewFinding;
    /** Who found it, when the review has several reviewers ("Sonnet 5", "Both"); `null` for one. */
    attribution: Readonly<{ label: string; backendIds: readonly string[] }> | null;
    /** The finding as first reported, when a reviewer's answer changed it. */
    original: ReviewFinding | null;
    density: ReviewFindingRowDensity;
    findBlockPrefix?: string;
    divided: boolean;
    /** `null` hides the decision (a read-only transcript). */
    decision: ReviewFindingDecision | 'undecided' | null;
    /** The decision can't be recorded yet (its comment is loading or missing). */
    decisionDisabled: boolean;
    /** Why a decision can't be recorded, shown under the control. */
    decisionNote: string | null;
    onDecide: (findingId: string, decision: ReviewFindingDecision) => void;
    /** `null` hides Ask about this (a read-only transcript). */
    followUp: ReviewFollowUpAvailability | null;
    threadEntries: readonly ReviewFindingThreadEntryView[];
    pendingQuestion: string | null;
    threadOpen: boolean;
    onToggleThread: (rowId: string) => void;
    /** Who a question goes to and where it is composed. */
    askContext: ReviewFindingAskContext;
    onAsk: (rowId: string, messageMarkdown: string) => Promise<boolean>;
}>) {
    const { theme } = useUnistyles();
    const { finding, rowId, onAsk, onDecide, onToggleThread } = props;
    const location = formatReviewFindingLocation(finding);
    const updated = props.original !== null;
    const severityChanged = props.original !== null && props.original.severity !== finding.severity;
    const replyCount = props.threadEntries.length;
    const askDisabled = props.followUp !== null && !props.followUp.available;
    const ask = React.useCallback((message: string) => onAsk(rowId, message), [onAsk, rowId]);
    const decide = React.useCallback((next: ReviewFindingDecision) => onDecide(rowId, next), [onDecide, rowId]);

    const decisionControl = props.decision !== null ? (
        <View style={props.density === 'card' ? styles.decisionAside : styles.decision}>
            <ReviewFindingDecisionControl
                testIDPrefix={`review-finding-triage:${rowId}`}
                decision={props.decision}
                disabled={props.decisionDisabled}
                onDecide={decide}
            />
        </View>
    ) : null;

    const threadToggle = props.followUp !== null ? (
        <Pressable
            testID={replyCount > 0 ? `review-finding-replies:${rowId}` : `review-finding-ask:${rowId}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: props.threadOpen, disabled: askDisabled && replyCount === 0 }}
            accessibilityHint={askDisabled && props.followUp && !props.followUp.available ? props.followUp.reason : undefined}
            disabled={askDisabled && replyCount === 0}
            onPress={() => onToggleThread(rowId)}
            style={styles.ask}
        >
            <Icon name="chat" size={ICON_SIZE.xs} color={askDisabled && replyCount === 0 ? theme.colors.text.tertiary : theme.colors.text.secondary} />
            <StructuredFindText blockId={`${props.findBlockPrefix}:thread-toggle`} text={replyCount > 0 ? t('runPage.review.replies', { count: replyCount }) : t('runPage.review.askAboutThis')} style={[styles.askText, askDisabled && replyCount === 0 ? styles.askTextDisabled : null]} />
            {replyCount > 0 ? (
                <DisclosureCaret expanded={props.threadOpen} size={ICON_SIZE.xs} />
            ) : null}
        </Pressable>
    ) : null;

    return (
        <View testID={`review-finding:${rowId}`} style={[styles.finding, props.divided ? styles.divided : null]}>
            <View style={styles.severity}>
                <ReviewSeverityLabel severity={finding.severity} findBlockId={`${props.findBlockPrefix}:severity`} />
            </View>
            <View style={styles.body}>
                <View style={props.density === 'card' ? styles.headRow : null}>
                    <View style={styles.head}>
                        <StructuredFindText blockId={`${props.findBlockPrefix}:title`} text={finding.title} style={styles.title} />
                        {location || props.attribution ? (
                            <View style={styles.placeRow}>
                                {location ? <StructuredFindText blockId={`${props.findBlockPrefix}:location`} text={location} selectable numberOfLines={1} style={styles.location} /> : null}
                                {props.attribution ? (
                                    <View testID={`review-finding-attribution:${rowId}`} style={styles.attribution}>
                                        {props.attribution.backendIds.map((backendId) => (hasAgentIconMark(backendId, theme)
                                            ? <AgentIcon key={backendId} agentId={backendId} size={ICON_SIZE.xs} />
                                            : null))}
                                        <Text numberOfLines={1} style={styles.attributionText}>{props.attribution.label}</Text>
                                    </View>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                    {props.density === 'card' ? decisionControl : null}
                </View>
                {updated ? (
                    <View testID={`review-finding-updated:${rowId}`} style={styles.updated}>
                        <Icon name="arrows-clockwise" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                        <StructuredFindText blockId={`${props.findBlockPrefix}:updated`} text={t('runPage.review.updatedAfterQuestion')} style={styles.updatedText} />
                        {severityChanged && props.original ? (
                            <StructuredFindText blockId={`${props.findBlockPrefix}:updated-severity`} text={`${reviewSeverityLabel(props.original.severity)} → ${reviewSeverityLabel(finding.severity)}`} style={styles.updatedDelta} />
                        ) : null}
                    </View>
                ) : null}
                {props.density === 'page' ? <Text selectable style={styles.summary}>{finding.summary}</Text> : null}
                {props.decision !== null && props.decisionNote ? <StructuredFindText blockId={`${props.findBlockPrefix}:decision-note`} text={props.decisionNote} style={styles.note} /> : null}
                {props.density === 'page' ? (
                    <View style={styles.actions}>
                        {decisionControl}
                        {threadToggle}
                    </View>
                ) : threadToggle}
                {props.threadOpen && props.followUp !== null ? (
                    props.followUp.available ? (
                        <ReviewFindingThread
                            rowId={rowId}
                            finding={finding}
                            entries={props.threadEntries}
                            pendingQuestion={props.pendingQuestion}
                            askContext={props.askContext}
                            onAsk={ask}
                            findBlockPrefix={props.findBlockPrefix}
                        />
                    ) : (
                        <ReviewFindingThreadHistory entries={props.threadEntries} findBlockPrefix={props.findBlockPrefix} />
                    )
                ) : null}
            </View>
        </View>
    );
});

/** Replies stay readable after a review stops taking questions. */
function ReviewFindingThreadHistory(props: Readonly<{ entries: readonly ReviewFindingThreadEntryView[]; findBlockPrefix?: string }>) {
    return (
        <View style={styles.history}>
            {props.entries.map((entry, index) => (
                <View key={`${entry.threadId}:${index}`} style={styles.historyEntry}>
                    <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:request`} text={entry.requestMarkdown} style={styles.summary} />
                    <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:reviewer`} text={entry.reviewerLabel} style={styles.historyAuthor} />
                    <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:answer`} text={entry.answerMarkdown} style={styles.summary} />
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    finding: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        paddingVertical: 14,
    },
    divided: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    severity: {
        width: REVIEW_SEVERITY_COLUMN_WIDTH_PX,
        paddingTop: theme.space.s2,
    },
    body: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s6,
    },
    headRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: theme.space.s10,
    },
    head: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 200,
        minWidth: 0,
        gap: theme.space.s2,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    placeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
        rowGap: theme.space.s2,
    },
    location: {
        ...Typography.variant('meta'),
        ...Typography.mono(),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    attribution: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    attributionText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    updated: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    updatedText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body', 'semiBold'),
    },
    updatedDelta: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('body'),
    },
    summary: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingTop: theme.space.s4,
    },
    decision: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    decisionAside: {
        alignSelf: 'flex-start',
        flexShrink: 0,
        maxWidth: '100%',
    },
    ask: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s6,
        paddingVertical: theme.space.s4,
    },
    askText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body', 'semiBold'),
    },
    askTextDisabled: {
        color: theme.colors.text.tertiary,
    },
    note: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
    },
    history: {
        gap: theme.space.s10,
        paddingTop: theme.space.s6,
    },
    historyEntry: {
        gap: theme.space.s2,
    },
    historyAuthor: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
    },
}));
