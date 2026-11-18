import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, usePreferredLanguage } from '@/text';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ReviewFindingBody, type ReviewFindingReviewer } from '@/components/reviews/finding/ReviewFindingBody';
import {
    ReviewFindingThread,
    ReviewFindingThreadEntries,
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

function decisionLabel(decision: ReviewFindingDecision | 'undecided'): string {
    switch (decision) {
        case 'undecided': return t('session.reviewFindings.status.untriaged');
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
    /** Every reviewer that reported it, first reporter first: the opened finding's conversation names them. */
    reviewers: readonly ReviewFindingReviewer[];
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
    /** `page`: the finding is opened (merged B). `card`: its thread is open under it. */
    expanded: boolean;
    onToggleExpanded: (rowId: string) => void;
    /** Who a question goes to and where it is composed. */
    askContext: ReviewFindingAskContext;
    onAsk: (rowId: string, messageMarkdown: string) => Promise<boolean>;
}>) {
    const { theme } = useUnistyles();
    const { finding, rowId, onAsk, onDecide, onToggleExpanded } = props;
    const location = formatReviewFindingLocation(finding);
    const replyCount = props.threadEntries.length;
    const askDisabled = props.followUp !== null && !props.followUp.available;
    const ask = React.useCallback((message: string) => onAsk(rowId, message), [onAsk, rowId]);
    const decide = React.useCallback((next: ReviewFindingDecision) => onDecide(rowId, next), [onDecide, rowId]);

    const decisionControl = props.decision !== null ? (
        <View style={props.density === 'card' ? styles.decisionAside : styles.decisionOpened}>
            <ReviewFindingDecisionControl
                testIDPrefix={`review-finding-triage:${rowId}`}
                decision={props.decision}
                disabled={props.decisionDisabled}
                onDecide={decide}
            />
        </View>
    ) : null;

    if (props.density === 'page') {
        return (
            <ReviewFindingPageRow
                {...props}
                decisionControl={decisionControl}
                ask={ask}
            />
        );
    }

    const threadToggle = props.followUp !== null ? (
        <Pressable
            testID={replyCount > 0 ? `review-finding-replies:${rowId}` : `review-finding-ask:${rowId}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: props.expanded, disabled: askDisabled && replyCount === 0 }}
            accessibilityHint={askDisabled && props.followUp && !props.followUp.available ? props.followUp.reason : undefined}
            disabled={askDisabled && replyCount === 0}
            onPress={() => onToggleExpanded(rowId)}
            style={styles.ask}
        >
            <Icon name="chat" size={ICON_SIZE.xs} color={askDisabled && replyCount === 0 ? theme.colors.text.tertiary : theme.colors.text.secondary} />
            <StructuredFindText blockId={`${props.findBlockPrefix}:thread-toggle`} text={replyCount > 0 ? t('runPage.review.replies', { count: replyCount }) : t('runPage.review.askAboutThis')} style={[styles.askText, askDisabled && replyCount === 0 ? styles.askTextDisabled : null]} />
            {replyCount > 0 ? (
                <DisclosureCaret expanded={props.expanded} size={ICON_SIZE.xs} />
            ) : null}
        </Pressable>
    ) : null;

    return (
        <View testID={`review-finding:${rowId}`} style={[styles.finding, props.divided ? styles.divided : null]}>
            <View style={styles.severity}>
                <ReviewSeverityLabel severity={finding.severity} findBlockId={`${props.findBlockPrefix}:severity`} />
            </View>
            <View style={styles.body}>
                <View style={styles.headRow}>
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
                    {decisionControl}
                </View>
                <ReviewFindingUpdatedNotice rowId={rowId} finding={finding} original={props.original} findBlockPrefix={props.findBlockPrefix} />
                {props.decision !== null && props.decisionNote ? <StructuredFindText blockId={`${props.findBlockPrefix}:decision-note`} text={props.decisionNote} style={styles.note} /> : null}
                {threadToggle}
                {props.expanded && props.followUp !== null ? (
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

/** "Updated after your question · High → Medium": a reviewer's answer changed the finding. */
function ReviewFindingUpdatedNotice(props: Readonly<{ rowId: string; finding: ReviewFinding; original: ReviewFinding | null; findBlockPrefix?: string }>) {
    const { theme } = useUnistyles();
    if (props.original === null) return null;
    const severityChanged = props.original.severity !== props.finding.severity;
    return (
        <View testID={`review-finding-updated:${props.rowId}`} style={styles.updated}>
            <Icon name="arrows-clockwise" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <StructuredFindText blockId={`${props.findBlockPrefix}:updated`} text={t('runPage.review.updatedAfterQuestion')} style={styles.updatedText} />
            {severityChanged ? (
                <StructuredFindText blockId={`${props.findBlockPrefix}:updated-severity`} text={`${reviewSeverityLabel(props.original.severity)} → ${reviewSeverityLabel(props.finding.severity)}`} style={styles.updatedDelta} />
            ) : null}
        </View>
    );
}

function decisionGlyph(decision: ReviewFindingDecision | 'undecided' | null) {
    switch (decision) {
        case 'accept': return 'check-circle' as const;
        case 'reject': return 'minus-circle' as const;
        case 'defer': return 'clock' as const;
        default: return 'circle' as const;
    }
}

/**
 * A finding on a result page (Reviews lab round 11, merged B). At rest: its decision state, title and
 * one meta line (severity, place, who found it), with the decision word at the end. Opened: the
 * decision control beside the title and the shared finding body under it. Below the shared row-stack
 * width (a phone, a split pane) the body runs the full width and the control moves under the title.
 */
function ReviewFindingPageRow(props: Readonly<React.ComponentProps<typeof ReviewFindingRow> & {
    decisionControl: React.ReactNode;
    ask: (messageMarkdown: string) => Promise<boolean>;
}>) {
    const { theme } = useUnistyles();
    const { finding, rowId, onToggleExpanded } = props;
    const [narrow, setNarrow] = React.useState(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (!Number.isFinite(width) || width <= 0) return;
        const next = width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
        setNarrow((current) => (current === next ? current : next));
    }, []);
    const location = formatReviewFindingLocation(finding);
    const ignored = props.decision === 'reject';
    const expanded = props.expanded;
    const decisionWord = props.decision === null ? null : decisionLabel(props.decision);
    const followUp = props.followUp;

    const conversation = followUp !== null && followUp.available ? (
        <ReviewFindingThreadEntries
            rowId={rowId}
            entries={props.threadEntries}
            pendingQuestion={props.pendingQuestion}
            askContext={props.askContext}
            onAsk={props.ask}
        />
    ) : (
        <>
            {props.threadEntries.length > 0 ? <ReviewFindingThreadHistory entries={props.threadEntries} /> : null}
            {followUp !== null && !followUp.available ? (
                <Text testID={`review-finding-ask-unavailable:${rowId}`} style={styles.note}>{followUp.reason}</Text>
            ) : null}
        </>
    );

    return (
        <View testID={`review-finding:${rowId}`} onLayout={onLayout} style={[styles.pageFinding, props.divided ? styles.divided : null]}>
            <View style={styles.pageHead}>
                <Pressable
                    testID={`review-finding-toggle:${rowId}`}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() => onToggleExpanded(rowId)}
                    style={styles.pageToggle}
                >
                    <View style={styles.pageGlyph}>
                        <Icon name={decisionGlyph(props.decision)} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                    </View>
                    <View style={styles.head}>
                        <Text style={[styles.title, ignored ? styles.titleIgnored : null]}>{finding.title}</Text>
                        <View style={styles.placeRow}>
                            <Text style={styles.metaText}>{reviewSeverityLabel(finding.severity)}</Text>
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
                    </View>
                </Pressable>
                {expanded && !narrow ? props.decisionControl : null}
                {!expanded && decisionWord !== null ? (
                    <Text testID={`review-finding-decision:${rowId}`} style={props.decision === 'undecided' ? styles.decisionPending : styles.decisionWord}>{decisionWord}</Text>
                ) : null}
            </View>
            {expanded ? (
                <View style={[styles.pageBody, narrow ? null : styles.pageBodyHung]}>
                    {narrow && props.decisionControl ? <View style={styles.pageDecisionNarrow}>{props.decisionControl}</View> : null}
                    <ReviewFindingBody
                        rowId={rowId}
                        finding={finding}
                        reviewers={props.reviewers}
                        notice={(
                            <>
                                <ReviewFindingUpdatedNotice rowId={rowId} finding={finding} original={props.original} />
                                {props.decision !== null && props.decisionNote ? <Text style={styles.note}>{props.decisionNote}</Text> : null}
                            </>
                        )}
                        conversation={conversation}
                    />
                </View>
            ) : null}
        </View>
    );
}

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
    // The page row (merged B): status glyph in the row's leading column, the body hung on the title's
    // text column while wide.
    pageFinding: {
        paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
        gap: theme.space.s16,
    },
    pageHead: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
    },
    pageToggle: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
    },
    pageGlyph: {
        width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx,
        alignItems: 'center',
        paddingTop: theme.space.s2,
    },
    pageBody: {
        gap: theme.space.s16,
    },
    pageBodyHung: {
        marginLeft: HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx,
    },
    pageDecisionNarrow: {
        alignSelf: 'stretch',
    },
    titleIgnored: {
        color: theme.colors.text.tertiary,
        textDecorationLine: 'line-through',
    },
    metaText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    decisionWord: {
        flexShrink: 0,
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    decisionPending: {
        flexShrink: 0,
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
    },
    decisionOpened: {
        alignSelf: 'flex-start',
        flexShrink: 0,
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
