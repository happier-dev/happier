import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import {
    ReviewFindingThread,
    type ReviewFindingAskContext,
    type ReviewFindingThreadEntryView,
} from '@/components/sessions/reviews/findings/ReviewFindingThread';
import type { ReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { formatReviewFindingLocation, reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { useReviewSeverityColors } from '@/components/sessions/reviews/findings/useReviewSeverityColors';

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
    const tabs = React.useMemo(() => REVIEW_FINDING_DECISIONS.map((decision) => ({ id: decision, label: decisionLabel(decision) })), []);
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
    // One severity colour wherever a finding is drawn (Walkthrough lab WT5): high red, medium amber, low blue, nit quiet.
    const severityColor = useReviewSeverityColors(finding.severity).foreground;
    const severityTextColor = severityColor;
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
            <Text style={[styles.askText, askDisabled && replyCount === 0 ? styles.askTextDisabled : null]}>
                {replyCount > 0 ? t('runPage.review.replies', { count: replyCount }) : t('runPage.review.askAboutThis')}
            </Text>
            {replyCount > 0 ? (
                <Icon name={props.threadOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            ) : null}
        </Pressable>
    ) : null;

    return (
        <View testID={`review-finding:${rowId}`} style={[styles.finding, props.divided ? styles.divided : null]}>
            <View style={styles.severity}>
                <View style={[styles.severityDot, { backgroundColor: severityColor }]} />
                <Text style={[styles.severityText, { color: severityTextColor }]}>{reviewSeverityLabel(finding.severity)}</Text>
            </View>
            <View style={styles.body}>
                <View style={props.density === 'card' ? styles.headRow : null}>
                    <View style={styles.head}>
                        <Text style={styles.title}>{finding.title}</Text>
                        {location || props.attribution ? (
                            <View style={styles.placeRow}>
                                {location ? <Text selectable numberOfLines={1} style={styles.location}>{location}</Text> : null}
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
                        <Text style={styles.updatedText}>{t('runPage.review.updatedAfterQuestion')}</Text>
                        {severityChanged && props.original ? (
                            <Text style={styles.updatedDelta}>
                                {`${reviewSeverityLabel(props.original.severity)} → ${reviewSeverityLabel(finding.severity)}`}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                {props.density === 'page' ? <Text selectable style={styles.summary}>{finding.summary}</Text> : null}
                {props.decision !== null && props.decisionNote ? <Text style={styles.note}>{props.decisionNote}</Text> : null}
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
                        />
                    ) : (
                        <ReviewFindingThreadHistory entries={props.threadEntries} />
                    )
                ) : null}
            </View>
        </View>
    );
});

/** Replies stay readable after a review stops taking questions. */
function ReviewFindingThreadHistory(props: Readonly<{ entries: readonly ReviewFindingThreadEntryView[] }>) {
    return (
        <View style={styles.history}>
            {props.entries.map((entry, index) => (
                <View key={`${entry.threadId}:${index}`} style={styles.historyEntry}>
                    <Text style={styles.summary}>{entry.requestMarkdown}</Text>
                    <Text style={styles.historyAuthor}>{entry.reviewerLabel}</Text>
                    <Text style={styles.summary}>{entry.answerMarkdown}</Text>
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    finding: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 14,
    },
    divided: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    severity: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 72,
        paddingTop: 2,
    },
    severityDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    severityText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
    },
    body: {
        flex: 1,
        minWidth: 0,
        gap: 6,
    },
    headRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 10,
    },
    head: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 200,
        minWidth: 0,
        gap: 2,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 20,
    },
    placeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 8,
        rowGap: 2,
    },
    location: {
        ...Typography.mono(),
        flexShrink: 1,
        color: theme.colors.text.secondary,
        fontSize: 12.5,
    },
    attribution: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    attributionText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12.5,
    },
    updated: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    updatedText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    updatedDelta: {
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        fontSize: 13,
    },
    summary: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13.5,
        lineHeight: 19,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        paddingTop: 4,
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
        gap: 6,
        paddingVertical: 4,
    },
    askText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    askTextDisabled: {
        color: theme.colors.text.tertiary,
    },
    note: {
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        fontSize: 12.5,
    },
    history: {
        gap: 10,
        paddingTop: 6,
    },
    historyEntry: {
        gap: 2,
    },
    historyAuthor: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13,
    },
}));
